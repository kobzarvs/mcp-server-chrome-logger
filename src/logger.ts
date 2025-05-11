import crypto from 'node:crypto';
import CDP, { Client } from 'chrome-remote-interface';

const IGNORED_STACK_PATTERNS = ['@vite/', 'node_modules'];
export const CHROME_HOST = process.env.CHROME_HOST || 'localhost';
export const CHROME_PORT = parseInt(process.env.CHROME_PORT || '9222');

interface LogEntry {
    message: string;
    timestamp: number;
}

interface ErrorEntry extends LogEntry {
    stack: string[];
    errorId: string;
    frameHash: string;
    sourceFile: string;
}

const logBuffer: LogEntry[] = [];
const errorBuffer: ErrorEntry[] = [];

const LOG_LIMIT = 100;
const ERROR_LIMIT = 100;

let currentClient: Client | null = null;
let currentTabTitle: string | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

function shouldIgnoreFrame(url: string): boolean {
    return IGNORED_STACK_PATTERNS.some(pattern => url.includes(pattern));
}

function formatStackTrace(stackTrace?: any): string[] {
    if (!stackTrace?.callFrames) return [];
    return stackTrace.callFrames
        .filter((frame: any) => !shouldIgnoreFrame(frame.url))
        .map(
            (frame: any) =>
                `  at ${frame.functionName || '<anonymous>'} (${frame.url}:${frame.lineNumber}:${frame.columnNumber})`,
        );
}

function getTopFrame(stackTrace?: any): any {
    if (!stackTrace?.callFrames) return null;
    return stackTrace.callFrames.find((frame: any) => !shouldIgnoreFrame(frame.url));
}

function hash(input: string): string {
    return crypto.createHash('sha1').update(input).digest('hex').slice(0, 10);
}

function addLog(message: string) {
    console.log('console', message);
    if (logBuffer.length === LOG_LIMIT) {
        logBuffer.pop();
    }
    logBuffer.unshift({ message, timestamp: Date.now() });
}

function addError(message: string, stack: string[], topFrameUrl: string) {
    const timestamp = Date.now();
    const topFrame = stack[0] || '';
    const frameHash = hash(topFrame);
    const errorId = hash(message + topFrame);

    console.log('error', message);

    if (errorBuffer.length === ERROR_LIMIT) {
        errorBuffer.pop();
    }

    errorBuffer.unshift({
        message,
        stack,
        timestamp,
        errorId,
        frameHash,
        sourceFile: topFrameUrl || '<unknown>',
    });
}

export function getLastErrors(count: number = 5, from: number = 0): ErrorEntry[] {
    return errorBuffer.slice(from, from + count);
}

export function getLastLogs(count: number = 10, from: number = 0): LogEntry[] {
    return logBuffer.slice(from, from + count);
}

export function getCurrentTabTitle(): string | null {
    return currentTabTitle;
}

export async function stopLogging() {
    if (currentClient) {
        try {
            await currentClient.close();
            console.log('🔌 Disconnected previous logging session');
        } catch (err) {
            console.warn('⚠️ Error while disconnecting:', err);
        }
        currentClient = null;
        currentTabTitle = null;
        reconnectAttempts = 0;
    }
}

export async function startLogging(titleContains: string) {
    await stopLogging();

    const tabs = await CDP.List({ host: CHROME_HOST, port: CHROME_PORT });
    const tab = tabs.find(t => t.title.includes(titleContains));

    if (!tab) {
        throw new Error(`Tab with title containing "${titleContains}" not found`);
    }

    const client = await CDP({
        host: CHROME_HOST,
        port: CHROME_PORT,
        local: true,
        secure: false,
        target: tab,
    });
    currentClient = client;
    currentTabTitle = tab.title;

    const { Runtime, Log, Page, Network } = client;

    await Promise.all([Runtime.enable(), Log.enable(), Page.enable(), Network.enable()]);

    const reconnect = async () => {
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            console.warn(`🔄 Attempting reconnect (${reconnectAttempts})...`);
            try {
                await startLogging(titleContains);
            } catch (e) {
                console.error('❌ Reconnect failed:', e);
            }
        } else {
            console.error('🚫 Max reconnect attempts reached.');
        }
    };

    client.on('disconnect', async () => {
        console.warn('💥 CDP disconnected. Reconnecting...');
        await reconnect();
    });

    Runtime.consoleAPICalled(({ type, args, stackTrace }) => {
        const message = args.map(arg => arg.value).join(' ');
        const formattedStack = formatStackTrace(stackTrace);
        const top = getTopFrame(stackTrace);

        if (type === 'error' || type === 'warning') {
            addError(message, formattedStack, top?.url || '');
        } else {
            addLog(message);
        }
    });

    Runtime.exceptionThrown(({ exceptionDetails }) => {
        const message = `[EXCEPTION] ${exceptionDetails.text}`;
        const stack = formatStackTrace(exceptionDetails.stackTrace);
        const top = getTopFrame(exceptionDetails.stackTrace);
        addError(message, stack, top?.url || '');
    });

    Log.entryAdded(({ entry }) => {
        const message = `[LOG][${entry.level}] ${entry.source}: ${entry.text}`;
        const stack = formatStackTrace(entry.stackTrace);
        const top = getTopFrame(entry.stackTrace);

        if (entry.level === 'error' || entry.level === 'warning') {
            addError(message, stack, top?.url || '');
        } else {
            addLog(message);
        }
    });

    console.log(`✅ Connected to tab: "${tab.title}"`);
}
