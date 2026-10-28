export function executionStatus(profile, { receipt = false } = {}) {
  if (!profile || typeof profile !== 'object') return {
    title: receipt ? 'Isolation not recorded' : 'Execution health unavailable', tone: 'unknown',
    description: receipt ? 'This receipt has no execution-isolation metadata.' : 'The server has not reported verified execution readiness.'
  };
  const mode = profile.mode || (profile.engine === 'docker' || profile.kind === 'docker' ? 'docker' : 'unknown');
  if (receipt) {
    if (profile.sandboxed === true && mode === 'docker') return { title: 'Docker isolation recorded', tone: 'ready', description: 'These isolation facts come from this execution receipt.' };
    if (mode === 'docker' && profile.sandboxed !== true) return { title: 'Sandbox execution not confirmed', tone: 'unavailable', description: 'This receipt does not verify a successful isolated execution. It does not indicate host fallback.' };
    if (profile.sandboxed === false) return { title: 'No OS sandbox recorded', tone: 'host', description: 'This receipt reports no OS isolation.' };
    return { title: 'Isolation not recorded', tone: 'unknown', description: 'The receipt does not verify OS isolation.' };
  }
  if (mode === 'docker') {
    if (profile.available === true && profile.sandboxed === true) return { title: 'Sandbox ready', tone: 'ready', description: 'Docker availability and isolation were verified at the last health check.' };
    if (profile.available === false) return { title: 'Sandbox unavailable', tone: 'unavailable', description: 'Docker execution was unavailable at the last health check.' };
    return { title: 'Sandbox readiness unknown', tone: 'unknown', description: 'Configuration alone does not establish a ready sandbox.' };
  }
  if (mode === 'host') return { title: profile.available === false ? 'Host execution unavailable' : 'Host execution · approval mode', tone: 'host', description: 'Host code runs with user permissions and no OS sandbox. Exact human approval is required.' };
  return { title: 'Execution health unavailable', tone: 'unknown', description: 'No recognized execution mode was reported.' };
}

export function executionFromResult(result) {
  if (!result || typeof result !== 'object') return null;
  const nested = result.execution && typeof result.execution === 'object' ? result.execution : null;
  if (nested || typeof result.sandboxed === 'boolean' || result.engine || result.isolation) {
    const actual = Object.fromEntries(['ok', 'exitCode', 'sandboxed', 'engine', 'isolation', 'network', 'hostMounts', 'image', 'language', 'limits', 'termination', 'cleanup']
      .filter(key => result[key] !== undefined).map(key => [key, result[key]]));
    return { ...nested, ...actual };
  }
  return null;
}

export function executionFromTool(tool) {
  const actual = executionFromResult(tool?.result);
  const receipt = tool?.receipt && typeof tool.receipt === 'object' ? tool.receipt : null;
  // tool_started execution describes configuration, not an executed result.
  // Only a result or the separate durable receipt establishes call facts.
  if (!actual && !receipt) return null;
  return { ...(tool?.execution || {}), ...(actual || {}), ...(receipt || {}) };
}

export function executionFacts(profile = {}, { receipt = false } = {}) {
  const unknown = receipt ? 'Not recorded' : 'Not reported';
  const value = (item, whenFalse, whenTrue) => item === false ? whenFalse : item === true ? whenTrue : unknown;
  const limits = profile.limits || {};
  const facts = [
    ['Mode', profile.mode || profile.engine || profile.kind || unknown],
    ['Isolation', profile.isolation || (profile.sandboxed === false && profile.mode !== 'docker' && profile.engine !== 'docker' ? 'No OS isolation' : unknown)],
    ['Network', value(receipt ? profile.network : profile.network ?? profile.policy?.network, 'Disabled', 'Allowed')],
    ['Host mounts', value(receipt ? profile.hostMounts : profile.hostMounts ?? profile.policy?.hostMounts, 'None', 'Allowed')],
  ];
  if (!receipt) {
    facts.push(['Configured sandbox', value(profile.sandboxedConfigured, 'No', 'Yes')]);
    facts.push(['Health availability', value(profile.available, 'Unavailable', 'Verified available')]);
    facts.push(['Approval', value(profile.approvalRequired, 'No per-call approval', 'Exact approval required')]);
  }
  for (const [key, label, unit] of [
    ['timeoutMs', 'Time limit', ' ms'], ['maxOutputBytes', 'Output limit', ' bytes'],
    ['memoryBytes', 'Memory limit', ' bytes'], ['cpus', 'CPU limit', ' cores'], ['pids', 'Process limit', ''], ['maxConcurrent', 'Concurrent calls', '']
  ]) if (Number.isFinite(limits[key])) facts.push([label, `${limits[key].toLocaleString()}${unit}`]);
  if (profile.language) facts.push(['Language', profile.language]);
  if (profile.engineVersion) facts.push(['Engine version', profile.engineVersion]);
  if (profile.image) facts.push(['Image', profile.image]);
  if (receipt) facts.push(['Container cleanup', profile.cleanup?.removed === true ? 'Removal confirmed' : profile.cleanup?.removed === false ? 'Removal not confirmed' : unknown]);
  if (profile.termination) facts.push(['Termination', typeof profile.termination === 'string' ? profile.termination : JSON.stringify(profile.termination)]);
  return facts;
}
