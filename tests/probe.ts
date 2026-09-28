// Test-only runtime; never an entry point of the production build.
import * as media from "mediabunny";
import * as timeline from "../services/timeline";
import { ffmpegService } from "../services/ffmpegService";
Object.assign(window, { testRuntime: { media, ffmpegService, timeline } });
