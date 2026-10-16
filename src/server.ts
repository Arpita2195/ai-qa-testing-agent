import Fastify from "fastify";
import { env } from "./config/env";
import healthRoutes from "./routes/health";

const app = Fastify({ logger: true });

app.register(healthRoutes);

async function start(): Promise<void> {
  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();