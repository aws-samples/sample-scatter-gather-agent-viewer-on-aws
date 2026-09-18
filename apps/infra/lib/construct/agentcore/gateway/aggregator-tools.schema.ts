import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';

const stringParam = (description: string): agentcore.SchemaDefinition => ({
  type: agentcore.SchemaDefinitionType.STRING,
  description,
});

/**
 * MCP tool schema for the aggregator gateway. Each tool here must have a
 * matching case in the Lambda handler (aggregator-tools.function.ts).
 */
export const aggregatorToolDefinitions: agentcore.ToolDefinition[] = [
  {
    name: 'list_sub_agents',
    description: 'List the sub-agent runtimes available in this account.',
    inputSchema: { type: agentcore.SchemaDefinitionType.OBJECT },
  },
  {
    name: 'invoke_sub_agent',
    description:
      'Invoke a sub-agent runtime with a prompt and return its response (scatter).',
    inputSchema: {
      type: agentcore.SchemaDefinitionType.OBJECT,
      properties: {
        runtime_arn: stringParam('ARN of the sub-agent runtime to invoke'),
        prompt: stringParam('Prompt describing the work for the sub-agent'),
      },
      required: ['runtime_arn', 'prompt'],
    },
  },
  {
    name: 'get_report',
    description: 'Read a sub-agent Markdown report from the aggregator S3 bucket.',
    inputSchema: {
      type: agentcore.SchemaDefinitionType.OBJECT,
      properties: {
        key: stringParam('S3 object key of the report'),
      },
      required: ['key'],
    },
  },
  {
    name: 'run_sql',
    description:
      'Run a SQL statement against the app Postgres database to record aggregated results.',
    inputSchema: {
      type: agentcore.SchemaDefinitionType.OBJECT,
      properties: {
        sql: stringParam('SQL statement to execute'),
      },
      required: ['sql'],
    },
  },
];
