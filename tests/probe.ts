// Test-only runtime; never an entry point of the production build.
import * as media from "mediabunny";
import * as timeline from "../services/timeline";
import * as audio from "../services/audio";
import { ffmpegService } from "../services/ffmpegService";
import React from "react";
import { createRoot } from "react-dom/client";
import { AudioEngine } from "../components/AudioEngine";
import { ExportResources } from "../services/exportJob";
import { decodeAudioInWorker } from "../services/audioWorker";
import { RecoveryStore } from "../services/recovery";
import * as mixing from "../services/mixing";
import { Flow as platform } from "../platform";
import App from "../App";
import { useProjectRecovery } from "../components/useProjectRecovery";
import { MediaSourceStore } from "../services/mediaSources";
Object.assign(window, {
  testRuntime: {
    media, ffmpegService, timeline, audio, React, createRoot, AudioEngine,
    lifecycle: { ExportResources, decodeAudioInWorker },
    RecoveryStore,
    mixing,
    platform,
    App, useProjectRecovery, MediaSourceStore,
  },
});
