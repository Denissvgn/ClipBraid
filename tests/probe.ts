// Test-only runtime; never an entry point of the production build.
import * as media from 'mediabunny';
import { ffmpegService } from '../services/ffmpegService';
Object.assign(window, { testRuntime: { media, ffmpegService } });
