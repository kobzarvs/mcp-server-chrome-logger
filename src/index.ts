import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import CDP from 'chrome-remote-interface';
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { CHROME_HOST, CHROME_PORT, getCurrentTabTitle, getLastErrors, getLastLogs, startLogging } from './logger';

const PORT = process.env.PORT || 4000;

const tabTitle = process.argv.find(arg => arg.startsWith('--title='))?.split('=')[1] || '';
if (!tabTitle) {
    console.error('Не задан обязательный параметр --title=string');
}

console.log('tabTitle', tabTitle);

let connectedToBrowser = false;

try {
    startLogging(tabTitle);
} catch (e) {
    console.error('Ошибка подключения к браузеру!');
    process.exit(1);
}

// Create an MCP server instance
const getServer = () => {
    const server = new McpServer(
        {
            name: 'chrome-logs',
            description: 'Chrome DevTools Protocol logs server',
            version: '1.0.0',
        },
        { capabilities: { logging: {} } },
    );

    server.tool('list-tabs', 'List all available Chrome tabs', {}, async (): Promise<CallToolResult> => {
        try {
            const tabs = await CDP.List({
                host: CHROME_HOST,
                port: CHROME_PORT,
            });

            if (tabs.length === 0) {
                return {
                    content: [{ type: 'text', text: '🔍 No open tabs found.' }],
                };
            }

            const lines = tabs.map(tab => {
                return `🆔 ${tab.id}\n📄 Title: ${tab.title}\n🔗 URL: ${tab.url}`;
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: `📑 Found ${tabs.length} tab(s):\n\n${lines.join('\n\n')}`,
                    },
                ],
            };
        } catch (err) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `❌ Failed to list tabs: ${(err as Error).message}`,
                    },
                ],
            };
        }
    });

    server.tool(
        'connect-to-tab',
        'Connect to a Chrome tab by title',
        {
            title: z.string().describe('Tab title or substring to match'),
        },
        async ({ title }): Promise<CallToolResult> => {
            try {
                await startLogging(title); // `startLogging` уже вызывает `stopLogging`
                return {
                    content: [
                        {
                            type: 'text',
                            text: `✅ Connected to tab with title containing "${title}"`,
                        },
                    ],
                };
            } catch (err: any) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `❌ Failed to connect to tab: ${err.message}`,
                        },
                    ],
                };
            }
        },
    );

    server.tool('get-current-tab', 'Get the currently connected Chrome tab', {}, async (): Promise<CallToolResult> => {
        const title = getCurrentTabTitle();

        return {
            content: [
                {
                    type: 'text',
                    text: title ? `🟢 Currently connected to tab: "${title}"` : `🔴 No tab is currently connected.`,
                },
            ],
        };
    });

    server.tool(
        'get-chrome-logs',
        'Get Chrome console logs',
        {
            count: z
                .number()
                .describe(
                    'Number of console logs to return. Logs are returned in chronological order: older logs first, newer logs last',
                )
                .default(10),
            from: z
                .number()
                .describe(
                    'Starting index (offset) for retrieving log entries. Logs are returned in chronological order: older logs first, newer logs last',
                )
                .default(0),
        },
        async ({ count, from }): Promise<CallToolResult> => {
            const logs = getLastLogs(count, from);
            const text =
                `🪵 part of the requested logs (${logs.length} of ${count}):\n\n` +
                logs
                    .map(log => {
                        const date = new Date(log.timestamp).toISOString();
                        return `[${date}] ${log.message}`;
                    })
                    .reverse()
                    .join('\n');
            return {
                content: [
                    {
                        type: 'text',
                        text,
                    },
                ],
            };
        },
    );

    server.tool(
        'get-chrome-errors',
        'Get recent Chrome errors',
        {
            count: z
                .number()
                .describe(
                    'Number of errors to return. Errors are returned in chronological order: older errors first, newer errors last',
                )
                .default(10),
            from: z
                .number()
                .describe(
                    'Starting index (offset) for retrieving error entries. Errors are returned in chronological order: older errors first, newer errors last',
                )
                .default(0),
        },
        async ({ count, from }): Promise<CallToolResult> => {
            const errors = getLastErrors(count, from);

            return {
                content: [
                    {
                        type: 'text',
                        text:
                            `❌ Here is another part of the requested errors ${errors.length} of ${count}:\n\n` +
                            errors
                                .map(err => {
                                    const date = new Date(err.timestamp).toISOString();
                                    return [
                                        `🕒 ${date}`,
                                        `🆔 errorId: ${err.errorId}`,
                                        `🔗 sourceFile: ${err.sourceFile}`,
                                        `🔹 frameHash: ${err.frameHash}`,
                                        `💬 message: ${err.message}`,
                                        `📄 stack:\n${err.stack.join('\n')}`,
                                        '---',
                                    ].join('\n');
                                })
                                .reverse()
                                .join('\n\n'),
                    },
                ],
            };
        },
    );

    return server;
};

const app = express();
app.use(express.json());

// Store transports by session ID
const transports: Record<string, SSEServerTransport> = {};

// SSE endpoint for establishing the stream
app.get('/sse', async (req: Request, res: Response) => {
    console.log('Received GET request to /sse (establishing SSE stream)');

    try {
        // Create a new SSE transport for the client
        // The endpoint for POST messages is '/messages'
        const transport = new SSEServerTransport('/messages', res);

        // Store the transport by session ID
        const sessionId = transport.sessionId;
        transports[sessionId] = transport;

        // Set up onclose handler to clean up transport when closed
        transport.onclose = async () => {
            console.log(`SSE transport closed for session ${sessionId}`);
            delete transports[sessionId];
            // await chromeLogger.disconnect();
        };

        // Connect the transport to the MCP server
        const server = getServer();
        await server.connect(transport);

        // await transport.start();

        console.log(`Established SSE stream with session ID: ${sessionId}`);
    } catch (error) {
        console.error('Error establishing SSE stream:', error);
        if (!res.headersSent) {
            res.status(500).send('Error establishing SSE stream');
        }
    }
});

// Messages endpoint for receiving client JSON-RPC requests
app.post('/messages', async (req: Request, res: Response) => {
    console.log('Received POST request to /messages');

    // Extract session ID from URL query parameter
    // In the SSE protocol, this is added by the client based on the endpoint event
    const sessionId = req.query.sessionId as string | undefined;

    if (!sessionId) {
        console.error('No session ID provided in request URL');
        res.status(400).send('Missing sessionId parameter');
        return;
    }

    const transport = transports[sessionId];
    if (!transport) {
        console.error(`No active transport found for session ID: ${sessionId}`);
        res.status(404).send('Session not found');
        return;
    }

    try {
        // Handle the POST message with the transport
        await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
        console.error('Error handling request:', error);
        if (!res.headersSent) {
            res.status(500).send('Error handling request');
        }
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Simple SSE Server (deprecated protocol version 2024-11-05) listening on port ${PORT}`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');

    // Close all active transports to properly clean up resources
    for (const sessionId in transports) {
        try {
            console.log(`Closing transport for session ${sessionId}`);
            await transports[sessionId].close();
            delete transports[sessionId];
        } catch (error) {
            console.error(`Error closing transport for session ${sessionId}:`, error);
        }
    }
    console.log('Server shutdown complete');
    process.exit(0);
});
