/**
 * One entry per supported language: which image to use, what filename the
 * submission's code should be saved as inside the box, how to compile it
 * (if it needs compiling at all), and how to run it once ready.
 *
 * Image names and build/run commands are execution detail — they belong to
 * the engine, not to any caller.
 */
import type { Language } from "@vj/shared";

export interface LanguageConfig {
  id: Language;
  image: string;
  sourceFilename: string;
  compileCmd?: string[];
  runCmd: string[];
}

export const LANGUAGES: Record<Language, LanguageConfig> = {
  cpp: {
    id: "cpp",
    image: "judge-cpp",
    sourceFilename: "main.cpp",
    compileCmd: ["g++", "main.cpp", "-o", "main", "-O2"],
    runCmd: ["./main"],
  },
  java: {
    id: "java",
    image: "judge-java",
    // Java requires the filename to match the public class name exactly —
    // so every Java submission's public class must be named "Main".
    sourceFilename: "Main.java",
    compileCmd: ["javac", "Main.java"],
    runCmd: ["java", "Main"],
  },
  python: {
    id: "python",
    image: "judge-python",
    sourceFilename: "main.py",
    // No compileCmd — Python is interpreted, there's nothing to compile.
    runCmd: ["python3", "main.py"],
  },
};
