const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname, { extensions: ['html'] }));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'QPMS', time: new Date().toISOString() });
});

// API placeholder endpoints so the deployment has a stable backend base.
// The current supplied QPMS UI keeps its demo workflow state client-side.
app.get('/api/config', (req, res) => {
  res.json({ name: 'Question Paper Management System', version: '1.0.0', mode: 'demo' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`QPMS running on port ${PORT}`);
});
