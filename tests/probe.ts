// Test-only runtime; never an entry point of the production build.
import * as media from "mediabunny";
import * as timeline from "../services/timeline";
import * as audio from "../services/audio";
import { ffmpegService } from "../services/ffmpegService";
import React from "react";
import { createRoot } from "react-dom/client";
import { AudioEngine } from "../components/AudioEngine";
Object.assign(window, {
  testRuntime: {
    media, ffmpegService, timeline, audio, React, createRoot, AudioEngine,
  },
});
