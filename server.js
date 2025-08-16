import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import generateRoute from './src/routes/generate.js';
import authRoute from './src/routes/auth.js';
import configApi from './src/config/configApi.js';
import exportRoute from './src/routes/export.js';
import streamRoute from './src/routes/stream.js';
import promptRegistry from './src/config/promptRegistry.js';
import describeRoute from './src/routes/describe.js';
import generateStreamRoute from './src/routes/generateStream.js';
import clarifyRoute from './src/routes/clarify.js';
import metricsRoute from './src/routes/metrics.js';
import searchRoute from './src/routes/search.js';
import { logger } from './src/utils/logger.js';
import { TokenStore } from './src/config/tokenStore.js';

dotenv.config();

// Initialize token persistence (load from disk if present)
await TokenStore.init();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
// Serve static files from public/
app.use(express.static('public'));

app.get('/health', (_, res) => res.json({ ok: true }));
app.use('/auth', authRoute);
app.use('/', configApi);
app.use('/', exportRoute);
app.use('/', streamRoute);
app.use('/', promptRegistry);
app.use('/', describeRoute);
app.use('/generate', generateRoute);
app.use('/', generateStreamRoute);
app.use('/clarify', clarifyRoute);
app.use('/metrics', metricsRoute);
app.use('/search', searchRoute);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => logger.info({ port }, 'MCP server listening'));


