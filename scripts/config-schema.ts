import { writeFileSync } from "node:fs";
import { z } from "zod";
import {
  connectionSchema,
  agentSchema,
} from "../packages/shared/src/config.ts";
writeFileSync(
  "docs/config.schema.json",
  JSON.stringify(
    z.toJSONSchema(
      z.object({ connection: connectionSchema, agent: agentSchema }),
    ),
    null,
    2,
  ) + "\n",
);
