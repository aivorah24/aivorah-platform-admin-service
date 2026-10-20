require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { requireAdmin } = require('./middleware/auth');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aivorah-platform-admin-service' }));

app.use('/overview', requireAdmin, require('./routes/overview'));
app.use('/students', requireAdmin, require('./routes/students'));
app.use('/teachers', requireAdmin, require('./routes/teachers'));
app.use('/schools', requireAdmin, require('./routes/schools'));
app.use('/admin/users', requireAdmin, require('./routes/adminUsers'));
app.use('/llm-stats', requireAdmin, require('./routes/llmStats'));
app.use('/charts-data', requireAdmin, require('./routes/charts-data'));

const PORT = process.env.PORT || 3023;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Aivorah Platform Admin service on http://localhost:${PORT}`));
}

module.exports = app;
