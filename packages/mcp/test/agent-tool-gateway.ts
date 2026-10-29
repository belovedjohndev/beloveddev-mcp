import type { Client } from '@modelcontextprotocol/client';
import { safeErrorSchema, toolSchemas } from '../src/schemas.js';
import { requireSafeError } from './evaluation-contract.js';
import {
  AgentFailure,
  readOnlyTools,
  readOnlyToolSchema,
  safeToolName,
  type AgentReport,
  type AgentFailureCode,
} from './agent-evaluation.js';

/** The fixture owns the server/database; the gateway owns only its SDK client. */
export class McpToolGateway {
  private discovered = false;
  constructor(private readonly client: Client) {}
  async discover(signal: AbortSignal) {
    try {
      const result = await this.client.listTools({}, { signal });
      if (
        result.nextCursor ||
        result.tools.length !== 8 ||
        new Set(result.tools.map((tool) => tool.name)).size !== 8 ||
        result.tools.some((tool) => !Object.hasOwn(toolSchemas, tool.name))
      )
        throw new AgentFailure('discovery_failed');
      const tools = readOnlyTools.map((name) => {
        const tool = result.tools.find((tool) => tool.name === name);
        if (!tool || tool.annotations?.readOnlyHint !== true || !tool.outputSchema)
          throw new AgentFailure('discovery_failed');
        return {
          name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
        };
      });
      if (Buffer.byteLength(JSON.stringify(tools)) > 131072)
        throw new AgentFailure('discovery_failed');
      this.discovered = true;
      return tools;
    } catch {
      throw new AgentFailure('discovery_failed');
    }
  }
  async invoke(
    name: string,
    args: Record<string, unknown>,
    report: AgentReport,
    signal: AbortSignal,
    maxBytes: number,
  ): Promise<string> {
    const reject = (code: AgentFailureCode): never => {
      report.rejectedTools.push(safeToolName(name));
      throw new AgentFailure(code);
    };
    if (name === 'create_project_note') return reject('write_tool_blocked');
    const allowed = readOnlyToolSchema.safeParse(name);
    if (!allowed.success) return reject('unknown_tool');
    if (!this.discovered) return reject('discovery_failed');
    const toolName = allowed.data;
    const input = toolSchemas[toolName].input.safeParse(args);
    if (!input.success) return reject('invalid_arguments');
    if (signal.aborted) throw new AgentFailure('execution_timeout');
    report.dispatchedTools.push(toolName);
    let response;
    try {
      response = await this.client.callTool({ name: toolName, arguments: input.data }, { signal });
    } catch {
      throw new AgentFailure('service_unavailable');
    }
    if (Buffer.byteLength(JSON.stringify(response)) > maxBytes)
      throw new AgentFailure('tool_response_limit');
    try {
      if (response.isError) {
        const first = response.content[0];
        if (first?.type !== 'text') throw new Error('Invalid error envelope.');
        const envelope = safeErrorSchema.parse(JSON.parse(first.text));
        requireSafeError(response, envelope.error.code);
        report.executedTools.push(toolName);
        return JSON.stringify(envelope);
      }
      const result = toolSchemas[toolName].output.parse(response.structuredContent);
      if (
        response.content.length !== 1 ||
        response.content[0]?.type !== 'text' ||
        response.content[0].text !== JSON.stringify(result)
      )
        throw new Error('Invalid success envelope.');
      report.executedTools.push(toolName);
      return JSON.stringify(result);
    } catch {
      throw new AgentFailure('invalid_tool_response');
    }
  }
  close() {
    return this.client.close();
  }
}
