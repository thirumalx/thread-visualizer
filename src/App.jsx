import { useState, useEffect } from 'react';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';
import { Pie } from 'react-chartjs-2';
import './App.css';
import { parseJBossCLIFormat } from './parser';
import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
ChartJS.register(ArcElement, Tooltip, Legend);

function App() {
  const [threads, setThreads] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const checkForUpdates = async () => {
      try {
        const update = await check();
        if (update) {
          console.log(`Found update ${update.version} from ${update.date}`);
          let downloaded = 0;
          let contentLength = 0;
          await update.downloadAndInstall((event) => {
            switch (event.event) {
              case 'Started':
                contentLength = event.data.contentLength;
                console.log(`started downloading ${event.data.contentLength} bytes`);
                break;
              case 'Progress':
                downloaded += event.data.chunkLength;
                console.log(`downloaded ${downloaded} from ${contentLength}`);
                break;
              case 'Finished':
                console.log('download finished');
                break;
            }
          });
          console.log('update installed, relaunching...');
          await relaunch();
        }
      } catch (err) {
        console.error('Failed to check for updates:', err);
      }
    };
    checkForUpdates();
  }, []);

  const handleFileUpload = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: 'Thread Dumps',
          extensions: ['txt', 'json']
        }]
      });
      if (selected) {
        const contents = await readTextFile(selected);
        try {
          const parsed = parseJBossCLIFormat(contents);
          if (parsed && parsed.result) {
            setThreads(parsed.result);
            setError('');
          } else {
            setError('Invalid thread dump format');
          }
        } catch (e) {
          setError('Failed to parse thread dump: ' + e.message);
        }
      }
    } catch (e) {
      setError('Error opening file: ' + e);
    }
  };

  const getChartData = () => {
    const states = { RUNNABLE: 0, WAITING: 0, TIMED_WAITING: 0, BLOCKED: 0 };
    threads.forEach(t => {
      if (t['thread-state']) {
        states[t['thread-state']] = (states[t['thread-state']] || 0) + 1;
      }
    });
    return {
      labels: Object.keys(states),
      datasets: [
        {
          data: Object.values(states),
          backgroundColor: ['#4caf50', '#ffeb3b', '#2196f3', '#f44336'],
          borderColor: ['#388e3c', '#fbc02d', '#1976d2', '#d32f2f'],
          borderWidth: 1,
        },
      ],
    };
  };

  const getThreadStats = () => {
    if (threads.length === 0) return null;
    let currentBlocked = 0;
    let currentWaiting = 0;
    let currentRunnable = 0;
    let totalBlockedTime = 0;
    let totalWaitedTime = 0;
    let hasTimeMetrics = true;

    threads.forEach(t => {
      const state = t['thread-state'];
      if (state === 'BLOCKED') currentBlocked++;
      if (state === 'WAITING' || state === 'TIMED_WAITING') currentWaiting++;
      if (state === 'RUNNABLE') currentRunnable++;

      if (t['blocked-time'] === -1 || t['waited-time'] === -1) {
        hasTimeMetrics = false;
      } else {
        totalBlockedTime += t['blocked-time'] || 0;
        totalWaitedTime += t['waited-time'] || 0;
      }
    });

    return {
      currentBlocked,
      currentWaiting,
      currentRunnable,
      avgBlockedTime: hasTimeMetrics ? Math.round(totalBlockedTime / threads.length) + ' ms' : 'N/A',
      avgWaitedTime: hasTimeMetrics ? Math.round(totalWaitedTime / threads.length) + ' ms' : 'N/A',
      hasTimeMetrics
    };
  };

  const threadStats = getThreadStats();

  const getTopMethods = () => {
    const methods = {};
    threads.forEach(t => {
      const stack = t['stack-trace'];
      if (stack && stack.length > 0) {
        const top = stack[0];
        const key = JSON.stringify({
          className: top['class-name'],
          methodName: top['method-name'],
          fileName: top['file-name'],
          lineNumber: top['line-number'],
          threadState: t['thread-state']
        });
        methods[key] = (methods[key] || 0) + 1;
      }
    });
    return Object.entries(methods)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, v]) => {
        const item = JSON.parse(k);
        let statusLabel = item.threadState || 'UNKNOWN';
        statusLabel = String(statusLabel);
        const m = item.methodName || '';
        const c = item.className || '';

        if (m === 'socketRead0' || m === 'read' || c.includes('SocketInputStream')) {
          statusLabel = 'Hung (Network)';
        } else if (c.includes('HikariPool') || c.includes('getConnection') || c.includes('BasicDataSource')) {
          statusLabel = 'Hung (Database)';
        } else if (c.includes('log4j') || c.includes('logback')) {
          statusLabel = 'Blocked (Logging)';
        } else if (m === 'park' || m === 'wait' || m === 'epollWait') {
          statusLabel = 'Idle/Parked';
        } else if (m === 'accept' || c.includes('Acceptor')) {
          statusLabel = 'Listening';
        } else if (c.includes('HashMap')) {
          statusLabel = 'Spinning (CPU)';
        } else if (statusLabel === 'RUNNABLE') {
          statusLabel = 'Running';
        }

        return { ...item, count: v, statusLabel };
      });
  };

  const generateInsights = () => {
    if (!threads || threads.length === 0) return null;
    const topMethods = getTopMethods();
    if (topMethods.length === 0) return null;

    const topMethod = topMethods[0];
    const percentage = Math.round((topMethod.count / threads.length) * 100);

    if (percentage > 15 && topMethod.count > 5) {
      const representativeThread = threads.find(t => {
        const stack = t['stack-trace'];
        if (!stack || stack.length === 0) return false;
        return stack[0]['class-name'] === topMethod.className && stack[0]['method-name'] === topMethod.methodName;
      });

      const fullClassName = topMethod.className || '';
      const methodName = topMethod.methodName || '';

      let rootCause = '';
      let recommendation = '';
      let title = "Critical Bottleneck Detected";
      let description = "The worker thread pool is becoming exhausted.";

      if (methodName === 'socketRead0' || methodName === 'read' || fullClassName.includes('SocketInputStream')) {
        rootCause = "Threads are waiting indefinitely for a response from an external network call or database query. This indicates a missing read timeout.";
        recommendation = "Set a connection/read timeout explicitly (e.g., 5s connection, 10-30s read) so threads can fail gracefully instead of hanging forever.";
      } else if (fullClassName.includes('HikariPool') || fullClassName.includes('getConnection') || fullClassName.includes('BasicDataSource')) {
        rootCause = "Threads are stuck waiting to acquire a Database Connection from the pool. The connection pool is likely exhausted.";
        recommendation = "Increase the database connection pool size, or investigate the application for connection leaks where DB connections are not being closed in a finally block.";
      } else if (fullClassName.includes('log4j') || fullClassName.includes('logback')) {
        rootCause = "Threads are blocked attempting to write logs. This usually happens if the disk is slow, or if synchronous logging is writing massive amounts of data.";
        recommendation = "Switch to Async Appenders for logging, or reduce the logging level (e.g., from DEBUG to INFO or WARN).";
      } else if (methodName === 'park' || methodName === 'wait' || methodName === 'epollWait') {
        title = "Idle Thread Pool Detected";
        description = "A large number of threads are idle and waiting for tasks.";
        rootCause = "These threads are safely parked or waiting in a queue for new tasks. This is perfectly normal for idle thread pools.";
        recommendation = "If the system is idle, no action is needed. If the system is hanging, check if upstream systems are failing to push events into this queue.";
      } else if (methodName === 'accept' || fullClassName.includes('Acceptor')) {
        title = "Normal Server Listeners";
        description = "Normal network listeners waiting for connections.";
        rootCause = "These threads are waiting to accept incoming network connections. This is standard healthy behavior for web servers like Tomcat or Undertow.";
        recommendation = "No action needed. These are healthy idle listener threads.";
      } else if (fullClassName.includes('HashMap')) {
        rootCause = "Threads are stuck performing operations on a HashMap. If this is a standard java.util.HashMap, it might be caught in a CPU-spinning infinite loop due to unsafe concurrent access.";
        recommendation = "Check the stack trace for concurrent modifications to a non-thread-safe collection, and replace it with ConcurrentHashMap if necessary.";
      } else {
        rootCause = "A large number of threads are occupied executing this exact same method, which is creating a significant bottleneck.";
        recommendation = "Investigate the service or logic being called in this stack trace to understand why it is taking so long or hanging.";
      }

      return {
        title: title,
        description: description,
        details: "Out of " + threads.length + " threads in the dump, " + topMethod.count + " threads (" + percentage + "%) are stuck in the exact same state: " + topMethod.className + "." + topMethod.methodName,
        rootCause: rootCause,
        recommendation: recommendation,
        stack: representativeThread ? representativeThread['stack-trace'] : []
      };
    }

    return {
      title: "Health Check Passed",
      description: "Thread distribution looks normal.",
      details: "No single method is overwhelmingly dominating the thread pool.",
      rootCause: null,
      recommendation: null,
      stack: []
    };
  };

  const insight = generateInsights();

  return (
    <div className="container">
      <div className="watermark-kural">
        <div className="tamil">எப்பொருள் யார்யார்வாய்க் கேட்பினும் அப்பொருள்<br />மெய்ப்பொருள் காண்ப தறிவு.</div>
        <div className="english">Whatever thing from whosoever's lips you hear,<br />it is wisdom to grasp the true meaning of that thing.</div>
      </div>
      <header>
        <div className="logo-title">
          <img src="/trex_logo.jpg" alt="T-Rex Logo" className="app-logo" />
          <h1>Thread Dump Visualizer</h1>
        </div>
        <div className="upload-container">
          <button className="upload-btn" onClick={handleFileUpload}>
            Select Thread Dump
          </button>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {threads.length > 0 && (
        <main className="dashboard">
          <div className="card overview">
            <h2>Total Threads: {threads.length}</h2>
            <div className="overview-content">
              <div className="chart-container">
                <Pie data={getChartData()} options={{ plugins: { legend: { position: 'right', labels: { color: '#fff' } } } }} />
              </div>

              {threadStats && (
                <div className="stats-container">
                  <h3>Metrics</h3>
                  <div className="stat-row">
                    <span className="stat-label">Runnable Count:</span>
                    <span className="stat-value">{threadStats.currentRunnable}</span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-label">Blocked Count:</span>
                    <span className="stat-value">{threadStats.currentBlocked}</span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-label">Waited Count:</span>
                    <span className="stat-value">{threadStats.currentWaiting}</span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-label">Blocked Time:</span>
                    <span className="stat-value" style={{ color: threadStats.hasTimeMetrics ? '#f8fafc' : '#fca5a5' }}>
                      {threadStats.avgBlockedTime}
                    </span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-label">Waited Time:</span>
                    <span className="stat-value" style={{ color: threadStats.hasTimeMetrics ? '#f8fafc' : '#fca5a5' }}>
                      {threadStats.avgWaitedTime}
                    </span>
                  </div>
                  {!threadStats.hasTimeMetrics && (
                    <div className="time-disabled-note">
                      * Time metrics (-1) are disabled in this JVM. Enable Thread Contention Monitoring via JMX to record blocked/waited times.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="card bottlenecks">
            <h2>Top Bottlenecks</h2>
            <ul>
              {getTopMethods().map((item, i) => (
                <li key={i}>
                  <div className="bottleneck-stats">
                    <span className="count">{item.count}</span>
                    <span className={`status-badge ${item.statusLabel.includes('Hung') ? 'danger fire' : item.statusLabel.includes('Spinning') ? 'danger' : item.statusLabel.includes('Idle') || item.statusLabel.includes('Listen') ? 'info' : 'warning'}`}>{item.statusLabel}</span>
                  </div>
                  <div className="method-details">
                    <div className="method-name">{item.className}.{item.methodName}</div>
                    <div className="file-name">{item.fileName}:{item.lineNumber}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {insight && (
            <div className="card insights full-width">
              <h2>{insight.title}</h2>
              <p className="insight-desc"><strong>{insight.description}</strong> {insight.details}</p>

              {insight.rootCause && (
                <div className="insight-section">
                  <h3>Root Cause Analysis</h3>
                  <p>{insight.rootCause}</p>
                </div>
              )}

              {insight.recommendation && (
                <div className="insight-section recommendation">
                  <h3>Recommendation</h3>
                  <p>{insight.recommendation}</p>
                </div>
              )}

              {insight.stack.length > 0 && (
                <div className="insight-section">
                  <h3>Relevant Stack Trace Snippet</h3>
                  <pre className="stack-snippet">
                    {insight.stack.map((frame, idx) => (
                      <div key={idx}>at {frame['class-name']}.{frame['method-name']}({frame['file-name']}:{frame['line-number']})</div>
                    ))}
                  </pre>
                </div>
              )}
            </div>
          )}
        </main>
      )}
    </div>
  );
}

export default App;




