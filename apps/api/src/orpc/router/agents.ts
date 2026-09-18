import {
  type AgentRuntime,
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
  type GetAgentRuntimeCommandOutput,
  ListAgentRuntimesCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-bedrock-agentcore-control'
import { awsSdkConfig } from '../../lib/aws-sdk'
import { base as os } from '../base'
import * as z from 'zod'

const client = new BedrockAgentCoreControlClient(awsSdkConfig)

/**
 * Every agent runtime in the account, following pagination. Exported so the
 * metrics router can label CloudWatch series without going back through the
 * oRPC layer.
 */
export async function listRuntimes(): Promise<AgentRuntime[]> {
  const runtimes: AgentRuntime[] = []
  let nextToken: string | undefined

  do {
    const response = await client.send(
      new ListAgentRuntimesCommand({ nextToken }),
    )
    runtimes.push(...(response.agentRuntimes ?? []))
    nextToken = response.nextToken
  } while (nextToken)

  return runtimes
}

export const listAgentRuntimes = os
  .input(z.object({}))
  .handler(async (): Promise<AgentRuntime[]> => listRuntimes())

export const getAgentRuntime = os
  .input(z.object({ agentRuntimeId: z.string() }))
  .handler(async ({ input }): Promise<GetAgentRuntimeCommandOutput | null> => {
    try {
      return await client.send(
        new GetAgentRuntimeCommand({ agentRuntimeId: input.agentRuntimeId }),
      )
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        return null
      }
      throw error
    }
  })
