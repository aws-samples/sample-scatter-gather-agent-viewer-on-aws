import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch'
import { awsSdkConfig } from '../../lib/aws-sdk'
import { base as os } from '../base'
import * as z from 'zod'
import { listRuntimes } from './agents'

const client = new CloudWatchClient(awsSdkConfig)

const AGENTCORE_NAMESPACE = 'AWS/Bedrock-AgentCore'
const BEDROCK_NAMESPACE = 'AWS/Bedrock'

/** One point per day. Every card and chart below is a daily series. */
const DAY_SECONDS = 86_400
const DAY_MS = DAY_SECONDS * 1000

/**
 * CloudWatch aligns daily buckets to UTC midnight. Anchoring our windows to the
 * same boundary keeps each bucket matching the date label we give it — a plain
 * `now - n * 86400s` window straddles two calendar days and silently drops the
 * current day's partial bucket.
 */
function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

export type MetricRange = 7 | 30 | 90

const rangeInput = z.object({
  days: z
    .union([z.literal(7), z.literal(30), z.literal(90)])
    .default(30),
})

export type AgentCoreStat = {
  /** Total across the requested window. */
  current: number
  /** Same-length window immediately before it, for the trend badge. */
  previous: number
}

export type AgentCoreSummary = {
  days: MetricRange
  invocations: AgentCoreStat
  sessions: AgentCoreStat
  /** Average InvokeAgentRuntime latency in milliseconds. */
  latencyMs: AgentCoreStat
  errors: AgentCoreStat
  /** Runtime resource consumption. AgentCore may delay these by up to an hour. */
  gbHours: AgentCoreStat
  vcpuHours: AgentCoreStat
}

export type TokenUsagePoint = {
  /** YYYY-MM-DD (UTC). */
  date: string
  input: number
  output: number
}

export type TokenUsage = {
  days: MetricRange
  points: TokenUsagePoint[]
  totalInput: number
  totalOutput: number
}

export type RuntimeTrendPoint = {
  /** YYYY-MM-DD (UTC). */
  date: string
  invocations: number
}

export type RuntimeMetricRow = {
  agentRuntimeId: string
  agentRuntimeName: string
  agentRuntimeArn: string
  /** READY, CREATE_FAILED, DELETING, ... straight from the control plane. */
  status: string
  version: string | null
  description: string | null
  lastUpdatedAt: string | null
  invocations: number
  sessions: number
  errors: number
  /** Average end-to-end InvokeAgentRuntime latency, in milliseconds. */
  latencyMs: number
  gbHours: number
  vcpuHours: number
  /** Most recent UTC day with at least one invocation, or null if idle. */
  lastActivity: string | null
  /** Daily invocations across the window, gap-filled, for the row sparkline. */
  trend: RuntimeTrendPoint[]
}

export type RuntimeMetrics = {
  days: MetricRange
  rows: RuntimeMetricRow[]
}

type Series = { timestamps: Date[]; values: number[] }

/**
 * AgentCore publishes the same underlying data under several overlapping
 * dimension sets (for example `Name+Operation+Resource` and
 * `ComputeType+Name+Operation+Resource`), so an unpinned SEARCH() sums the same
 * invocation more than once — a broad search reports roughly double the real
 * count. Each query below therefore targets exactly one dimension schema: the
 * `AggregateOperation` rollup series where AgentCore publishes one, and a
 * schema-pinned SEARCH() for `Latency` and `Errors`, which have no rollup.
 */
function agentCoreQueries(): MetricDataQuery[] {
  const rollup = (id: string, metricName: string, stat: string): MetricDataQuery => ({
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: AGENTCORE_NAMESPACE,
        MetricName: metricName,
        Dimensions: [
          { Name: 'AggregateOperation', Value: 'InvokeAgentRuntime' },
        ],
      },
      Period: DAY_SECONDS,
      Stat: stat,
    },
  })

  const accountUsage = (id: string, metricName: string): MetricDataQuery => ({
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: AGENTCORE_NAMESPACE,
        MetricName: metricName,
        // `Service` alone is the account-wide rollup; adding Resource/Name
        // would return one series per runtime instead.
        Dimensions: [{ Name: 'Service', Value: 'AgentCore.Runtime' }],
      },
      Period: DAY_SECONDS,
      Stat: 'Sum',
    },
  })

  const pinnedSearch = (
    id: string,
    metricName: string,
    stat: 'Sum' | 'Average',
  ): MetricDataQuery => ({
    Id: id,
    Expression:
      `${stat === 'Sum' ? 'SUM' : 'AVG'}(SEARCH('{${AGENTCORE_NAMESPACE},Name,Operation,Resource} ` +
      `MetricName="${metricName}" Operation="InvokeAgentRuntime"', '${stat}', ${DAY_SECONDS}))`,
    Period: DAY_SECONDS,
  })

  return [
    rollup('invocations', 'Invocations', 'Sum'),
    rollup('sessions', 'Sessions', 'Sum'),
    accountUsage('gbHours', 'MemoryUsed-GBHours'),
    accountUsage('vcpuHours', 'CPUUsed-vCPUHours'),
    pinnedSearch('latency', 'Latency', 'Average'),
    pinnedSearch('errors', 'Errors', 'Sum'),
  ]
}

function tokenQueries(): MetricDataQuery[] {
  // No dimensions = the account-wide rollup across every model. Adding a
  // ModelId dimension would scope this to a single model.
  return (
    [
      ['input', 'InputTokenCount'],
      ['output', 'OutputTokenCount'],
    ] as const
  ).map(([id, metricName]) => ({
    Id: id,
    MetricStat: {
      Metric: { Namespace: BEDROCK_NAMESPACE, MetricName: metricName },
      Period: DAY_SECONDS,
      Stat: 'Sum',
    },
  }))
}

async function fetchSeries(
  queries: MetricDataQuery[],
  startTime: Date,
  endTime: Date,
): Promise<Map<string, Series>> {
  const merged = new Map<string, Series>()
  let nextToken: string | undefined

  do {
    const response = await client.send(
      new GetMetricDataCommand({
        MetricDataQueries: queries,
        StartTime: startTime,
        EndTime: endTime,
        // Chronological, so chart points read left to right. CloudWatch
        // defaults to descending.
        ScanBy: 'TimestampAscending',
        NextToken: nextToken,
      }),
    )

    // A single query's points can be split across pages, so append rather
    // than replace.
    for (const result of response.MetricDataResults ?? []) {
      if (!result.Id) continue
      const series = merged.get(result.Id) ?? { timestamps: [], values: [] }
      series.timestamps.push(...(result.Timestamps ?? []))
      series.values.push(...(result.Values ?? []))
      merged.set(result.Id, series)
    }

    nextToken = response.NextToken
  } while (nextToken)

  return merged
}

/** Sums a series' points, counting only those at or after `from`. */
function sumFrom(series: Series | undefined, from: Date): number {
  if (!series) return 0
  let total = 0
  for (const [index, timestamp] of series.timestamps.entries()) {
    if (timestamp >= from) total += series.values[index] ?? 0
  }
  return total
}

/** Averages a series' points, counting only those at or after `from`. */
function averageFrom(series: Series | undefined, from: Date): number {
  if (!series) return 0
  let total = 0
  let count = 0
  for (const [index, timestamp] of series.timestamps.entries()) {
    if (timestamp >= from) {
      total += series.values[index] ?? 0
      count += 1
    }
  }
  return count === 0 ? 0 : total / count
}

function sumBefore(series: Series | undefined, before: Date): number {
  if (!series) return 0
  let total = 0
  for (const [index, timestamp] of series.timestamps.entries()) {
    if (timestamp < before) total += series.values[index] ?? 0
  }
  return total
}

function averageBefore(series: Series | undefined, before: Date): number {
  if (!series) return 0
  let total = 0
  let count = 0
  for (const [index, timestamp] of series.timestamps.entries()) {
    if (timestamp < before) {
      total += series.values[index] ?? 0
      count += 1
    }
  }
  return count === 0 ? 0 : total / count
}

/**
 * AgentCore runtime activity for the dashboard cards. Fetches twice the
 * requested window in one call and splits it at the midpoint so each card can
 * show a period-over-period delta.
 */
export const getAgentCoreSummary = os
  .input(rangeInput)
  .handler(async ({ input }): Promise<AgentCoreSummary> => {
    const days = input.days as MetricRange
    const endTime = new Date()
    const today = startOfUtcDay(endTime)
    // Current window is the last `days` UTC days including today; the previous
    // window is the `days` immediately before it.
    const cutoff = new Date(today - (days - 1) * DAY_MS)
    const startTime = new Date(today - (2 * days - 1) * DAY_MS)

    const series = await fetchSeries(agentCoreQueries(), startTime, endTime)

    const total = (id: string): AgentCoreStat => ({
      current: sumFrom(series.get(id), cutoff),
      previous: sumBefore(series.get(id), cutoff),
    })

    const mean = (id: string): AgentCoreStat => ({
      current: averageFrom(series.get(id), cutoff),
      previous: averageBefore(series.get(id), cutoff),
    })

    return {
      days,
      invocations: total('invocations'),
      sessions: total('sessions'),
      latencyMs: mean('latency'),
      errors: total('errors'),
      gbHours: total('gbHours'),
      vcpuHours: total('vcpuHours'),
    }
  })

/**
 * Daily Bedrock input/output token counts for the dashboard chart. CloudWatch
 * omits days with no activity, so gaps are filled with zeroes to keep the area
 * chart continuous.
 */
export const getTokenUsage = os
  .input(rangeInput)
  .handler(async ({ input }): Promise<TokenUsage> => {
    const days = input.days as MetricRange
    const endTime = new Date()
    const today = startOfUtcDay(endTime)
    const startTime = new Date(today - (days - 1) * DAY_MS)

    const series = await fetchSeries(tokenQueries(), startTime, endTime)

    // Seed every day in the window so days with no Bedrock activity render as
    // zero instead of leaving a hole in the area chart.
    const byDate = new Map<string, TokenUsagePoint>()
    for (let offset = 0; offset < days; offset += 1) {
      const key = new Date(startTime.getTime() + offset * DAY_MS)
        .toISOString()
        .slice(0, 10)
      byDate.set(key, { date: key, input: 0, output: 0 })
    }

    for (const field of ['input', 'output'] as const) {
      const found = series.get(field)
      if (!found) continue
      for (const [index, timestamp] of found.timestamps.entries()) {
        const key = timestamp.toISOString().slice(0, 10)
        const point = byDate.get(key)
        if (point) point[field] = found.values[index] ?? 0
      }
    }

    const points = [...byDate.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    )

    return {
      days,
      points,
      totalInput: points.reduce((sum, point) => sum + point.input, 0),
      totalOutput: points.reduce((sum, point) => sum + point.output, 0),
    }
  })

/** Six queries per runtime, and GetMetricData accepts at most 500 per call. */
const RUNTIMES_PER_BATCH = 80

const RUNTIME_METRICS = [
  { suffix: 'inv', metricName: 'Invocations', stat: 'Sum' },
  { suffix: 'ses', metricName: 'Sessions', stat: 'Sum' },
  { suffix: 'err', metricName: 'Errors', stat: 'Sum' },
  { suffix: 'lat', metricName: 'Latency', stat: 'Average' },
] as const

const RUNTIME_USAGE_METRICS = [
  { suffix: 'mem', metricName: 'MemoryUsed-GBHours' },
  { suffix: 'cpu', metricName: 'CPUUsed-vCPUHours' },
] as const

/**
 * Per-runtime queries.
 *
 * The invocation family is only published under the full
 * `Name+Operation+Resource` schema — querying `Operation+Resource` alone returns
 * no data for runtimes, despite that schema existing in ListMetrics for gateway
 * and memory resources. `Name` is `AgentName::EndpointName`; we assume the
 * DEFAULT endpoint, and a runtime served from a different endpoint simply
 * reports zero rather than failing.
 *
 * Resource usage is published under `Service+Resource` instead, so it needs its
 * own dimension set.
 */
function runtimeQueries(
  runtimes: { name: string; arn: string }[],
): MetricDataQuery[] {
  return runtimes.flatMap((runtime, index) => {
    const invocationDimensions = [
      { Name: 'Name', Value: `${runtime.name}::DEFAULT` },
      { Name: 'Operation', Value: 'InvokeAgentRuntime' },
      { Name: 'Resource', Value: runtime.arn },
    ]
    const usageDimensions = [
      { Name: 'Service', Value: 'AgentCore.Runtime' },
      { Name: 'Resource', Value: runtime.arn },
    ]

    return [
      ...RUNTIME_METRICS.map(({ suffix, metricName, stat }) => ({
        Id: `r${index}_${suffix}`,
        MetricStat: {
          Metric: {
            Namespace: AGENTCORE_NAMESPACE,
            MetricName: metricName,
            Dimensions: invocationDimensions,
          },
          Period: DAY_SECONDS,
          Stat: stat,
        },
      })),
      ...RUNTIME_USAGE_METRICS.map(({ suffix, metricName }) => ({
        Id: `r${index}_${suffix}`,
        MetricStat: {
          Metric: {
            Namespace: AGENTCORE_NAMESPACE,
            MetricName: metricName,
            Dimensions: usageDimensions,
          },
          Period: DAY_SECONDS,
          Stat: 'Sum',
        },
      })),
    ]
  })
}

function sumAll(series: Series | undefined): number {
  return series?.values.reduce((total, value) => total + value, 0) ?? 0
}

function averageAll(series: Series | undefined): number {
  if (!series || series.values.length === 0) return 0
  return sumAll(series) / series.values.length
}

/**
 * AgentCore usage broken down per agent runtime, for the dashboard table. Joins
 * the control-plane runtime list (names, status, version) to CloudWatch series
 * keyed by runtime ARN, so runtimes that exist but have never been invoked still
 * appear, reporting zero.
 */
export const getRuntimeMetrics = os
  .input(rangeInput)
  .handler(async ({ input }): Promise<RuntimeMetrics> => {
    const days = input.days as MetricRange
    const endTime = new Date()
    const today = startOfUtcDay(endTime)
    const startTime = new Date(today - (days - 1) * DAY_MS)

    const runtimes = (await listRuntimes())
      .map((runtime) => ({
        id: runtime.agentRuntimeId ?? '',
        name: runtime.agentRuntimeName ?? '',
        arn: runtime.agentRuntimeArn ?? '',
        status: runtime.status ?? 'UNKNOWN',
        version: runtime.agentRuntimeVersion ?? null,
        description: runtime.description ?? null,
        lastUpdatedAt: runtime.lastUpdatedAt?.toISOString() ?? null,
      }))
      // A runtime without a name or ARN can't be matched to a metric series.
      .filter((runtime) => runtime.name !== '' && runtime.arn !== '')

    // Every day in the window, so sparklines are continuous rather than sparse.
    const dates: string[] = []
    for (let offset = 0; offset < days; offset += 1) {
      dates.push(
        new Date(startTime.getTime() + offset * DAY_MS)
          .toISOString()
          .slice(0, 10),
      )
    }

    const series = new Map<string, Series>()
    for (let start = 0; start < runtimes.length; start += RUNTIMES_PER_BATCH) {
      const batch = runtimes.slice(start, start + RUNTIMES_PER_BATCH)
      const batchSeries = await fetchSeries(
        runtimeQueries(batch),
        startTime,
        endTime,
      )
      // Ids restart at r0 per batch, so re-key them onto the global index.
      for (const [id, value] of batchSeries) {
        const match = /^r(\d+)_(\w+)$/.exec(id)
        if (!match) continue
        series.set(`r${start + Number(match[1])}_${match[2]}`, value)
      }
    }

    const rows: RuntimeMetricRow[] = runtimes.map((runtime, index) => {
      const invocations = series.get(`r${index}_inv`)

      const daily = new Map<string, number>(dates.map((date) => [date, 0]))
      let lastActivity: string | null = null
      for (const [point, timestamp] of (invocations?.timestamps ?? []).entries()) {
        const date = timestamp.toISOString().slice(0, 10)
        const value = invocations?.values[point] ?? 0
        if (daily.has(date)) daily.set(date, value)
        if (value > 0) lastActivity = date
      }

      return {
        agentRuntimeId: runtime.id,
        agentRuntimeName: runtime.name,
        agentRuntimeArn: runtime.arn,
        status: runtime.status,
        version: runtime.version,
        description: runtime.description,
        lastUpdatedAt: runtime.lastUpdatedAt,
        invocations: sumAll(invocations),
        sessions: sumAll(series.get(`r${index}_ses`)),
        errors: sumAll(series.get(`r${index}_err`)),
        latencyMs: averageAll(series.get(`r${index}_lat`)),
        gbHours: sumAll(series.get(`r${index}_mem`)),
        vcpuHours: sumAll(series.get(`r${index}_cpu`)),
        lastActivity,
        trend: dates.map((date) => ({
          date,
          invocations: daily.get(date) ?? 0,
        })),
      }
    })

    // Busiest first, so the table opens on what matters.
    rows.sort(
      (a, b) => b.invocations - a.invocations || b.gbHours - a.gbHours,
    )

    return { days, rows }
  })
