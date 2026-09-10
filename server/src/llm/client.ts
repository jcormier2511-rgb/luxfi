import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

// Resolves ANTHROPIC_API_KEY from the environment.
export const anthropic = new Anthropic();
export const LLM_MODEL = config.llm.model;
