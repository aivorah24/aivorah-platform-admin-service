require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { requireAdmin } = require('./middleware/auth');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aivorah-platform-admin-service' }));

app.use('/overview', requireAdmin, require('./routes/overview'));

const PORT = process.env.PORT || 3023;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Aivorah Platform Admin service on http://localhost:${PORT}`));
}

module.exports = app;
