import { Request, Response } from 'express';
import config from './config';
import { DebugLogger } from './utils/logger';
import axios from 'axios';

const debugLogger = new DebugLogger();

// MCP sessions for SSE
const mcpSessions = new Map<string, Response>();

interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    [key: string]: unknown;
  };
  id?: string | number | null;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export const mcpGetHandler = (req: Request, res: Response): void => {
  const sessionId = (req.query.sessionId as string) || Math.random().toString(36).substring(2);
  mcpSessions.set(sessionId, res);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control',
  });
  res.write(`event: endpoint\ndata: /mcp?sessionId=${sessionId}\n\n`);

  res.on('close', () => {
    mcpSessions.delete(sessionId);
  });
};

export const mcpPostHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const apiKey = req.headers.authorization?.replace('Bearer ', '') ||
                   (req.headers['x-api-key'] as string);

    if (config.apiKey && !config.apiKey.includes(apiKey || '')) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Unauthorized - Invalid API key' },
        id: req.body.id || null
      });
      return;
    }

    const { jsonrpc, method, params, id } = req.body as JsonRpcRequest;

    if (jsonrpc !== '2.0') {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid JSON-RPC version' },
        id: id || null
      });
      return;
    }

    const sessionId = req.query.sessionId as string;
    const sessionRes = mcpSessions.get(sessionId);

    const sendResponse = (response: JsonRpcResponse): void => {
      if (sessionRes) {
        sessionRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        res.status(200).end();
      } else {
        res.json(response);
      }
    };

    const sendError = (error: JsonRpcResponse): void => {
      if (sessionRes) {
        sessionRes.write(`event: message\ndata: ${JSON.stringify(error)}\n\n`);
        res.status(200).end();
      } else {
        res.status(error.error?.code === -32600 ? 400 : 500).json(error);
      }
    };

    switch (method) {
      case 'initialize':
        sendResponse({
          jsonrpc: '2.0',
          id: id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {
                listChanged: false
              }
            },
            serverInfo: {
              name: 'qwen-proxy-mcp-server',
              version: '1.0.0'
            }
          }
        });
        break;

      case 'tools/list':
        sendResponse({
          jsonrpc: '2.0',
          id: id,
          result: {
            tools: [{
              name: 'web_search',
              description: 'Search the web using Qwen\'s search infrastructure with automatic account rotation',
              inputSchema: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'The search query to perform'
                  },
                  page: {
                    type: 'number',
                    description: 'Page number for pagination (default: 1, min: 1)',
                    minimum: 1
                  },
                  rows: {
                    type: 'number',
                    description: 'Number of results per page (default: 10, min: 1, max: 100)',
                    minimum: 1,
                    maximum: 100
                  }
                },
                required: ['query']
              }
            }]
          }
        });
        break;

      case 'tools/call': {
        const { name, arguments: args } = params || {};

        if (name === 'web_search') {
          const { query, page, rows } = (args || {}) as { query?: string; page?: number; rows?: number };

          if (!query || typeof query !== 'string') {
            sendError({
              jsonrpc: '2.0',
              error: { code: -32602, message: 'Invalid or missing query parameter' },
              id: id
            });
            break;
          }

          try {
            const response = await axios.post(`http://${config.host}:${config.port}/v1/web/search`, {
              query: query.trim(),
              page: page || 1,
              rows: rows || 10
            });

            sendResponse({
              jsonrpc: '2.0',
              id: id,
              result: {
                content: [{
                  type: 'text',
                  text: JSON.stringify(response.data, null, 2)
                }]
              }
            });
          } catch (searchError) {
            sendError({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Web search failed: ' + (searchError as Error).message },
              id: id
            });
          }
        } else {
          sendError({
            jsonrpc: '2.0',
            error: { code: -32601, message: `Tool '${name}' not found` },
            id: id
          });
        }
        break;
      }

      default:
        sendError({
          jsonrpc: '2.0',
          error: { code: -32601, message: `Method '${method}' not found` },
          id: id
        });
    }
  } catch (error) {
    console.error('MCP endpoint error:', (error as Error).message);
    await debugLogger.logApiCall('/mcp', req, null, error as Error);
    await debugLogger.logError('/mcp', error as Error, 'error');

    const sessionId = req.query.sessionId as string;
    const sessionRes = mcpSessions.get(sessionId);
    const errorResponse: JsonRpcResponse = {
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal server error' },
      id: req.body.id || null
    };

    if (sessionRes) {
      sessionRes.write(`event: message\ndata: ${JSON.stringify(errorResponse)}\n\n`);
      res.status(200).end();
    } else {
      res.status(500).json(errorResponse);
    }
  }
};
