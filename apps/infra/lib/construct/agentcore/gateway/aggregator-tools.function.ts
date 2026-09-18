/**
 * Handler backing the aggregator gateway's MCP tools.
 *
 * The gateway invokes this function once per tool call: the tool arguments
 * arrive as the event payload, and the fully-qualified tool name
 * ('targetName___toolName') arrives in the Lambda client context.
 */
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  ListAgentRuntimesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'aws-lambda';

const sdkConfig = { customUserAgent: process.env.USER_AGENT_STRING };

const s3 = new S3Client(sdkConfig);
const rdsData = new RDSDataClient(sdkConfig);
const agentCore = new BedrockAgentCoreClient(sdkConfig);
const agentCoreControl = new BedrockAgentCoreControlClient(sdkConfig);

interface InvokeSubAgentInput {
  runtime_arn: string;
  prompt: string;
}

interface GetReportInput {
  key: string;
}

interface RunSqlInput {
  sql: string;
}

export const handler = async (event: unknown, context: Context) => {
  // The Node.js runtime surfaces the client context with a capitalized
  // 'Custom' key; be lenient about the casing.
  const clientContext = context.clientContext as
    | { custom?: Record<string, string>; Custom?: Record<string, string> }
    | undefined;
  const custom = clientContext?.custom ?? clientContext?.Custom ?? {};
  const toolName = (custom.bedrockAgentCoreToolName ?? '').split('___').pop();

  switch (toolName) {
    case 'list_sub_agents': {
      const out = await agentCoreControl.send(new ListAgentRuntimesCommand({}));
      return (out.agentRuntimes ?? []).map((r) => ({
        arn: r.agentRuntimeArn,
        name: r.agentRuntimeName,
        description: r.description,
      }));
    }

    case 'invoke_sub_agent': {
      const { runtime_arn, prompt } = event as InvokeSubAgentInput;
      const out = await agentCore.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: runtime_arn,
          payload: JSON.stringify({ prompt }),
        }),
      );
      return { response: await out.response?.transformToString() };
    }

    case 'get_report': {
      const { key } = event as GetReportInput;
      const out = await s3.send(
        new GetObjectCommand({
          Bucket: process.env.AGGREGATOR_BUCKET_NAME,
          Key: key,
        }),
      );
      return { content: await out.Body?.transformToString() };
    }

    case 'run_sql': {
      const { sql } = event as RunSqlInput;
      const out = await rdsData.send(
        new ExecuteStatementCommand({
          resourceArn: process.env.DB_CLUSTER_ARN,
          secretArn: process.env.DB_SECRET_ARN,
          database: process.env.DB_NAME,
          sql,
          includeResultMetadata: true,
        }),
      );
      return {
        records: out.records ?? [],
        numberOfRecordsUpdated: out.numberOfRecordsUpdated ?? 0,
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
};
