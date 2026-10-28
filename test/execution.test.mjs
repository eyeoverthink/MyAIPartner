import test from 'node:test';
import assert from 'node:assert/strict';
import { executionStatus, executionFromResult, executionFromTool, executionFacts } from '../src/execution.mjs';

test('configured Docker is never labeled ready without verified availability and isolation', () => {
  const configured = { mode: 'docker', sandboxedConfigured: true };
  assert.equal(executionStatus(configured).title, 'Sandbox readiness unknown');
  assert.equal(executionStatus({ ...configured, available: false, sandboxed: false }).title, 'Sandbox unavailable');
  assert.equal(executionStatus({ ...configured, available: true, sandboxed: false }).title, 'Sandbox readiness unknown');
  assert.equal(executionStatus({ ...configured, available: true, sandboxed: true }).title, 'Sandbox ready');
});

test('host capability explicitly reports approval and no OS sandbox', () => {
  const profile = { mode: 'host', available: true, sandboxed: false, approvalRequired: true };
  assert.match(executionStatus(profile).title, /Host execution.*approval/);
  const facts = Object.fromEntries(executionFacts(profile));
  assert.equal(facts.Isolation, 'No OS isolation');
  assert.equal(facts.Approval, 'Exact approval required');
  assert.equal(facts.Network, 'Not reported');
});

test('historical execution receipts use their own isolation facts with unknown metadata left unknown', () => {
  const host = executionFromResult({ ok: true, sandboxed: false, stdout: 'old result' });
  assert.equal(executionStatus(host, { receipt: true }).title, 'No OS sandbox recorded');
  assert.equal(executionFromResult({ ok: false, error: 'unavailable' }), null);
  assert.equal(executionStatus(null, { receipt: true }).title, 'Isolation not recorded');
});

test('Docker receipt exposes recorded network, host mounts, resource limits and cleanup', () => {
  const receipt = { engine: 'docker', isolation: 'docker-linux', sandboxed: true, network: false, hostMounts: false,
    image: 'sha256:immutable', limits: { timeoutMs: 15000, memoryBytes: 268435456, pids: 64, cpus: 1 }, cleanup: { removed: true } };
  assert.equal(executionStatus(receipt, { receipt: true }).title, 'Docker isolation recorded');
  const facts = Object.fromEntries(executionFacts(receipt, { receipt: true }));
  assert.equal(facts.Network, 'Disabled');
  assert.equal(facts['Host mounts'], 'None');
  assert.equal(facts['Container cleanup'], 'Removal confirmed');
  assert.equal(facts.Image, 'sha256:immutable');
  assert.equal(facts['Process limit'], '64');
});

test('bounded tool results retain the separate durable isolation receipt and configuration alone proves no execution', () => {
  const execution = { mode: 'docker', sandboxedConfigured: true, available: true, sandboxed: true, checkedAt: 123 };
  assert.equal(executionFromTool({ execution }), null);
  const receipt = { ok: true, sandboxed: true, engine: 'docker', isolation: 'docker-linux', network: false, hostMounts: false,
    image: 'sha256:retained', cleanup: { removed: true }, limits: { pids: 64 } };
  const profile = executionFromTool({ execution, receipt, result: { truncated: true, ok: true, sandboxed: true, engine: 'docker', outputPreview: 'bounded' } });
  assert.equal(profile.image, receipt.image);
  assert.equal(profile.cleanup.removed, true);
  assert.equal(profile.checkedAt, execution.checkedAt);
  assert.equal(executionStatus(profile, { receipt: true }).title, 'Docker isolation recorded');
});

test('an unavailable Docker result never becomes a host-fallback or verified network-isolation claim', () => {
  const profile = executionFromTool({ execution: { mode: 'docker', available: false, sandboxed: false, policy: { network: false, hostMounts: false } },
    receipt: { ok: false, sandboxed: false, engine: 'docker' }, result: { ok: false, error: 'sandbox unavailable' } });
  assert.equal(executionStatus(profile, { receipt: true }).title, 'Sandbox execution not confirmed');
  const facts = Object.fromEntries(executionFacts(profile, { receipt: true }));
  assert.equal(facts.Network, 'Not recorded');
  assert.equal(facts['Host mounts'], 'Not recorded');
});
