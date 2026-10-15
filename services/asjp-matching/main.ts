// ASJP matching service entry point (LOCAL PROTOTYPE): configuration and credentials from the environment only
// (asjpServiceConfigFromEnv). Logs carry no credential and no manuscript text: pins, worker count, readiness.
import { asjpServiceConfigFromEnv, startAsjpService } from "./server";

const config = asjpServiceConfigFromEnv();
const service = await startAsjpService(config);
const health = service.pool();
console.log(JSON.stringify({ event: "asjp-service-ready", port: config.port, workers: config.workers, generationId: config.generation.generationId, licencePolicy: config.generation.licencePolicy, features: config.generation.features ?? null, goldenOk: health.goldenOk }));
const stop = () => { service.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
