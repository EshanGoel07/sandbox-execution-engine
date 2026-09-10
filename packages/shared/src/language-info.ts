/**
 * The public face of each supported language — what `GET /api/v1/languages`
 * returns. How to actually build and run each one (image, commands) is
 * execution detail and lives in @vj/engine's language config.
 *
 * Both tables are `Record<Language, ...>`, so adding a language to the
 * `Language` union fails the typecheck until it has an entry in each — the
 * two cannot drift apart silently. This half lives in @vj/shared because the
 * API is not allowed to import the engine.
 *
 * Versions track the base image tags in apps/worker/images/<lang>/Dockerfile.
 */
import type { Language } from "./verdict";

export interface LanguageInfo {
  id: Language;
  name: string;
  version: string;
  /** Anything a caller must know to get code to run at all. */
  notes: string | null;
}

export const LANGUAGE_INFO: Record<Language, LanguageInfo> = {
  cpp: {
    id: "cpp",
    name: "C++",
    version: "GCC 13",
    notes: "Compiled with g++ -O2.",
  },
  java: {
    id: "java",
    name: "Java",
    version: "OpenJDK 21",
    notes: "The public class must be named Main.",
  },
  python: {
    id: "python",
    name: "Python",
    version: "CPython 3.12",
    notes: null,
  },
};
