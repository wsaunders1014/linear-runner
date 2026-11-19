#!/usr/bin/env node
import crypto from 'node:crypto';
import { loadDotEnv } from '../src/config.mjs';
import { computeLinearSignature } from '../src/verify.mjs';

loadDotEnv();

const secret = process.env.LINEAR_WEBHOOK_SECRET;
if (!secret) {
  console.error('Set LINEAR_WEBHOOK_SECRET in .env or environment first.');
  process.exit(1);
}

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);

// Usage:
//   node bin/send-test-webhook.mjs [plan|implement] [label]
const modeArg = process.argv[2] || 'plan';
const isImplement = modeArg === 'implement' || modeArg === 'in-progress';
const agentLabel =
  modeArg === 'plan' || isImplement
    ? process.argv[3] || process.env.REQUIRED_LABEL || 'agent'
    : modeArg;

const issueId = crypto.randomUUID();
const deliveryId = crypto.randomUUID();

const payload = isImplement
  ? {
      action: 'update',
      type: 'Issue',
      webhookTimestamp: Date.now(),
      url: 'https://linear.app/test/issue/TEST-101',
      updatedFrom: { stateId: 'state-todo-id' },
      data: {
        id: issueId,
        identifier: 'TEST-101',
        title: 'Sample webhook test issue',
        description: 'Implement the agreed plan.',
        state: { id: 'state-in-progress-id', name: process.env.IN_PROGRESS_STATE_NAME || 'In Progress' },
        labels: agentLabel ? [{ name: agentLabel }] : [],
      },
    }
  : {
      action: 'create',
      type: 'Issue',
      webhookTimestamp: Date.now(),
      url: 'https://linear.app/test/issue/TEST-101',
      data: {
        id: issueId,
        identifier: 'TEST-101',
        title: 'Sample webhook test issue',
        description: 'Investigate the repository structure and propose a short plan.',
        state: { id: 'state-todo-id', name: 'Todo' },
        labels: agentLabel ? [{ name: agentLabel }] : [],
      },
    };

const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
const signature = computeLinearSignature(rawBody, secret);

const res = await fetch(`http://${host}:${port}/linear`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Linear-Signature': signature,
    'Linear-Delivery': deliveryId,
  },
  body: rawBody,
});

const text = await res.text();
console.log(`HTTP ${res.status}: ${text}`);
