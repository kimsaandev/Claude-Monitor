const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Config ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3200;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');

// ─── Express + WebSocket Setup ────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ─── State ────────────────────────────────────────────────────────
const fileOffsets = new Map();    // Track read position per file
const activeSessions = new Map(); // sessionId -> session metadata
const clients = new Set();

// ─── WebSocket Connection ─────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected (${clients.size} total)`);

  // Send current state snapshot
  ws.send(JSON.stringify({
    type: 'snapshot',
    sessions: Object.fromEntries(activeSessions),
    timestamp: new Date().toISOString()
  }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected (${clients.size} total)`);
  });
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// ─── JSONL Parser ─────────────────────────────────────────────────
function parseJsonlLine(line) {
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
}

function classifyEvent(obj, filePath) {
  const isSubagent = filePath.includes('/subagents/') || filePath.includes('\\subagents\\');
  const agentId = obj.agentId || null;

  const base = {
    sessionId: obj.sessionId || extractSessionId(filePath),
    timestamp: obj.timestamp || new Date().toISOString(),
    uuid: obj.uuid || null,
    parentUuid: obj.parentUuid || null,
    isSubagent,
    agentId,
    isSidechain: obj.isSidechain || false,
  };

  switch (obj.type) {
    case 'queue-operation':
      return { ...base, category: 'queue', operation: obj.operation, content: obj.content };

    case 'progress':
      if (obj.data?.type === 'hook_progress') {
        return {
          ...base,
          category: 'hook',
          hookEvent: obj.data.hookEvent,
          hookName: obj.data.hookName,
          command: obj.data.command,
        };
      }
      if (obj.data?.type === 'agent_progress') {
        const agentMsg = obj.data.message;
        if (agentMsg?.type === 'user') {
          return {
            ...base,
            category: 'agent_task',
            agentId: agentMsg.agentId || agentId,
            content: truncateContent(agentMsg.message?.content),
          };
        }
        if (agentMsg?.type === 'assistant') {
          const toolUses = extractToolUses(agentMsg.message?.content);
          const textContent = extractText(agentMsg.message?.content);
          return {
            ...base,
            category: 'agent_response',
            agentId: agentMsg.agentId || agentId,
            tools: toolUses,
            text: textContent,
            model: agentMsg.message?.model,
          };
        }
        return {
          ...base,
          category: 'agent_progress',
          data: summarizeData(obj.data),
        };
      }
      return { ...base, category: 'progress', data: summarizeData(obj.data) };

    case 'user':
      return {
        ...base,
        category: 'user_message',
        content: truncateContent(obj.message?.content),
        cwd: obj.cwd,
        version: obj.version,
        gitBranch: obj.gitBranch,
      };

    case 'assistant':
      const toolUses = extractToolUses(obj.message?.content);
      const textContent = extractText(obj.message?.content);
      const thinkingContent = extractThinking(obj.message?.content);
      return {
        ...base,
        category: 'assistant_message',
        tools: toolUses,
        text: textContent,
        thinking: thinkingContent,
        model: obj.message?.model,
        stopReason: obj.message?.stop_reason,
        usage: obj.message?.usage ? {
          input: obj.message.usage.input_tokens,
          output: obj.message.usage.output_tokens,
          cacheRead: obj.message.usage.cache_read_input_tokens,
        } : null,
      };

    case 'system':
      return {
        ...base,
        category: 'system',
        subtype: obj.subtype,
        hookCount: obj.hookCount,
        hookInfos: obj.hookInfos,
      };

    default:
      return { ...base, category: 'unknown', rawType: obj.type };
  }
}

function extractToolUses(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(c => c.type === 'tool_use')
    .map(c => ({
      name: c.name,
      id: c.id,
      input: summarizeToolInput(c.name, c.input),
    }));
}

function extractText(content) {
  if (typeof content === 'string') return truncate(content, 300);
  if (!Array.isArray(content)) return '';
  return content
    .filter(c => c.type === 'text')
    .map(c => truncate(c.text, 300))
    .join(' ');
}

function extractThinking(content) {
  if (!Array.isArray(content)) return '';
  const thinking = content.find(c => c.type === 'thinking');
  return thinking ? truncate(thinking.thinking, 200) : '';
}

function summarizeToolInput(toolName, input) {
  if (!input) return {};
  switch (toolName) {
    case 'Read': return { file: input.file_path };
    case 'Write': return { file: input.file_path };
    case 'Edit': return { file: input.file_path };
    case 'Bash': return { command: truncate(input.command, 100), description: input.description };
    case 'Grep': return { pattern: input.pattern, path: input.path };
    case 'Glob': return { pattern: input.pattern, path: input.path };
    case 'Agent': return { description: input.description, type: input.subagent_type };
    case 'Skill': return { skill: input.skill };
    case 'TodoWrite': return { count: Array.isArray(input.todos) ? input.todos.length : 0 };
    default: return { keys: Object.keys(input).slice(0, 3) };
  }
}

function summarizeData(data) {
  if (!data) return null;
  const s = JSON.stringify(data);
  return s.length > 200 ? JSON.parse(truncate(s, 200)) : data;
}

function truncateContent(content) {
  if (typeof content === 'string') return truncate(content, 300);
  if (Array.isArray(content)) {
    return content.map(c => {
      if (c.type === 'text') return { type: 'text', text: truncate(c.text, 300) };
      if (c.type === 'tool_use') return { type: 'tool_use', name: c.name };
      return { type: c.type };
    });
  }
  return content;
}

function truncate(str, maxLen) {
  if (!str) return '';
  if (typeof str !== 'string') str = JSON.stringify(str);
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

function extractSessionId(filePath) {
  const match = filePath.match(/([a-f0-9-]{36})\.jsonl$/);
  return match ? match[1] : path.basename(filePath, '.jsonl');
}

function extractProjectName(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/projects\/([^/]+)\//);
  if (match) {
    return match[1].replace(/^C--Users-Administrator-/, '').replace(/-/g, '/');
  }
  return 'unknown';
}

// ─── File Watcher ─────────────────────────────────────────────────
function readNewLines(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const offset = fileOffsets.get(filePath) || 0;

    if (stat.size <= offset) return;

    const buffer = Buffer.alloc(stat.size - offset);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    fs.closeSync(fd);

    fileOffsets.set(filePath, stat.size);

    const lines = buffer.toString('utf-8').split('\n').filter(l => l.trim());
    return lines;
  } catch (err) {
    console.error(`[ERR] Reading ${filePath}:`, err.message);
    return [];
  }
}

function processFile(filePath) {
  const lines = readNewLines(filePath);
  if (!lines || lines.length === 0) return;

  const projectName = extractProjectName(filePath);

  for (const line of lines) {
    const obj = parseJsonlLine(line);
    if (!obj) continue;

    const event = classifyEvent(obj, filePath);
    event.project = projectName;

    // Update active sessions
    if (event.sessionId) {
      if (!activeSessions.has(event.sessionId)) {
        activeSessions.set(event.sessionId, {
          id: event.sessionId,
          project: projectName,
          startTime: event.timestamp,
          lastActivity: event.timestamp,
          events: 0,
          tools: {},
          agents: new Set(),
          files: new Set(),
        });
      }
      const session = activeSessions.get(event.sessionId);
      session.lastActivity = event.timestamp;
      session.events++;

      // Track tool usage
      if (event.tools) {
        for (const tool of event.tools) {
          session.tools[tool.name] = (session.tools[tool.name] || 0) + 1;
          // Track files
          if (tool.input?.file) {
            session.files.add(tool.input.file);
          }
        }
      }

      // Track agents
      if (event.agentId) {
        session.agents.add(event.agentId);
      }
    }

    broadcast({ type: 'event', event });
  }
}

// Initialize watcher
function startWatcher() {
  const watchPatterns = [
    path.join(PROJECTS_DIR, '**', '*.jsonl'),
  ];

  console.log(`[WATCH] Watching: ${PROJECTS_DIR}`);

  const watcher = chokidar.watch(watchPatterns, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    usePolling: process.platform === 'win32',
    interval: 200,
  });

  // On initial add, set offset to end of file (only watch NEW content)
  watcher.on('add', (filePath) => {
    try {
      const stat = fs.statSync(filePath);
      fileOffsets.set(filePath, stat.size);
      console.log(`[WATCH] Tracking: ${path.basename(filePath)} (${stat.size} bytes)`);
    } catch {}
  });

  watcher.on('change', (filePath) => {
    if (filePath.endsWith('.jsonl')) {
      processFile(filePath);
    }
  });

  watcher.on('error', (err) => {
    console.error('[WATCH] Error:', err.message);
  });

  return watcher;
}

// ─── REST API: Session History ────────────────────────────────────
app.get('/api/sessions', (req, res) => {
  try {
    const sessions = [];
    const projectDirs = fs.readdirSync(PROJECTS_DIR);

    for (const projDir of projectDirs) {
      const projPath = path.join(PROJECTS_DIR, projDir);
      if (!fs.statSync(projPath).isDirectory()) continue;

      const files = fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const filePath = path.join(projPath, file);
        const sessionId = file.replace('.jsonl', '');
        const stat = fs.statSync(filePath);

        // Read first and last line for metadata
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        const firstObj = lines.length > 0 ? parseJsonlLine(lines[0]) : null;
        const lastObj = lines.length > 0 ? parseJsonlLine(lines[lines.length - 1]) : null;

        sessions.push({
          id: sessionId,
          project: projDir.replace(/^C--Users-Administrator-/, '').replace(/-/g, '/'),
          size: stat.size,
          lineCount: lines.length,
          firstTimestamp: firstObj?.timestamp,
          lastTimestamp: lastObj?.timestamp,
          gitBranch: firstObj?.gitBranch || lastObj?.gitBranch,
          cwd: firstObj?.cwd || lastObj?.cwd,
        });
      }
    }

    sessions.sort((a, b) => (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''));
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:id', (req, res) => {
  try {
    const sessionId = req.params.id;
    let filePath = null;

    // Search for the session file
    const projectDirs = fs.readdirSync(PROJECTS_DIR);
    for (const projDir of projectDirs) {
      const candidate = path.join(PROJECTS_DIR, projDir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        filePath = candidate;
        break;
      }
    }

    if (!filePath) return res.status(404).json({ error: 'Session not found' });

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const events = [];

    for (const line of lines) {
      const obj = parseJsonlLine(line);
      if (!obj) continue;
      events.push(classifyEvent(obj, filePath));
    }

    // Also load subagent files
    const sessionDir = path.join(path.dirname(filePath), sessionId);
    const subagentDir = path.join(sessionDir, 'subagents');
    const subagents = [];

    if (fs.existsSync(subagentDir)) {
      const subFiles = fs.readdirSync(subagentDir);
      for (const sf of subFiles) {
        if (sf.endsWith('.meta.json')) {
          const meta = JSON.parse(fs.readFileSync(path.join(subagentDir, sf), 'utf-8'));
          subagents.push(meta);
        }
        if (sf.endsWith('.jsonl')) {
          const subContent = fs.readFileSync(path.join(subagentDir, sf), 'utf-8');
          const subLines = subContent.split('\n').filter(l => l.trim());
          for (const sl of subLines) {
            const obj = parseJsonlLine(sl);
            if (obj) events.push(classifyEvent(obj, path.join(subagentDir, sf)));
          }
        }
      }
    }

    // Sort by timestamp
    events.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

    res.json({
      sessionId,
      project: extractProjectName(filePath),
      eventCount: events.length,
      subagents,
      events,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health endpoint ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    clients: clients.size,
    watching: fileOffsets.size,
    activeSessions: activeSessions.size,
  });
});

// ─── Start ────────────────────────────────────────────────────────
startWatcher();

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   CLAUDE MONITOR v1.0                            ║
║   Dashboard: http://localhost:${PORT}               ║
║   WebSocket: ws://localhost:${PORT}                 ║
║   Watching:  ~/.claude/projects/**/*.jsonl        ║
╚══════════════════════════════════════════════════╝
  `);
});
