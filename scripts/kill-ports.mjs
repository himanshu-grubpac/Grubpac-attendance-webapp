import killPort from 'kill-port';

const ports = [Number(process.env.PORT ?? 5000), 5173];

for (const port of ports) {
  try {
    await killPort(port);
    console.log(`Freed port ${port}`);
  } catch {
    console.log(`Port ${port} was not in use`);
  }
}
