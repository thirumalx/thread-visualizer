import { useState } from 'react';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';
import { Pie } from 'react-chartjs-2';
import './App.css';
import { parseJBossCLIFormat } from './parser';

ChartJS.register(ArcElement, Tooltip, Legend);

function App() {
  const [threads, setThreads] = useState([]);
  const [error, setError] = useState('');

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const contents = e.target.result;
      try {
        const parsed = parseJBossCLIFormat(contents);
        if (parsed && parsed.result) {
          setThreads(parsed.result);
          setError('');
        } else {
          setError('Invalid thread dump format');
        }
      } catch (err) {
        setError('Failed to parse thread dump: ' + err.message);
      }
    };
    reader.onerror = () => {
      setError('Error reading file');
    };
    reader.readAsText(file);
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

  const getTopMethods = () => {
    const methods = {};
    threads.forEach(t => {
      const stack = t['stack-trace'];
      if (stack && stack.length > 0) {
        const top = stack[0];
        const methodStr = `${top['class-name']}.${top['method-name']}`;
        methods[methodStr] = (methods[methodStr] || 0) + 1;
      }
    });
    return Object.entries(methods).sort((a, b) => b[1] - a[1]).slice(0, 10);
  };

  return (
    <div className="container">
      <header>
        <h1>Thread Dump Visualizer</h1>
        <div className="upload-container">
           <label className="upload-btn">
              Select Thread Dump
              <input 
                type="file" 
                accept=".txt,.json" 
                onChange={handleFileUpload} 
                style={{ display: 'none' }} 
              />
           </label>
        </div>
      </header>
      
      {error && <div className="error">{error}</div>}
      
      {threads.length > 0 && (
        <main className="dashboard">
          <div className="card overview">
            <h2>Total Threads: {threads.length}</h2>
            <div className="chart-container">
              <Pie data={getChartData()} options={{ plugins: { legend: { position: 'right', labels: { color: '#fff' } } } }} />
            </div>
          </div>
          
          <div className="card bottlenecks">
            <h2>Top Bottlenecks</h2>
            <ul>
              {getTopMethods().map(([method, count]) => (
                <li key={method}>
                  <span className="count">{count}</span>
                  <span className="method">{method}</span>
                </li>
              ))}
            </ul>
          </div>
        </main>
      )}
    </div>
  );
}

export default App;
