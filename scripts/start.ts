const apiProc = Bun.spawn(['bun', 'run', '--cwd', 'apps/api', 'start'], {
  stdout: 'inherit',
  stderr: 'inherit',
  stdin: 'inherit',
  env: process.env,
});

const webProc = Bun.spawn(['bun', 'run', '--cwd', 'apps/web', 'start'], {
  stdout: 'inherit',
  stderr: 'inherit',
  stdin: 'inherit',
  env: process.env,
});

function shutdown(signal: NodeJS.Signals) {
  apiProc.kill(signal);
  webProc.kill(signal);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await Promise.race([apiProc.exited, webProc.exited]);
shutdown('SIGTERM');
