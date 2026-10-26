/** Inspect actual received bytes with pinned browser decoders; no native CLI dependency. */
export async function inspectOutput(probe, bytes, queries = []) {
  return probe.evaluate(async ({base64,queries})=>{
    const m=window.testRuntime.media;
    const input=new m.Input({source:new m.BlobSource(new Blob([Uint8Array.from(atob(base64),value=>value.charCodeAt(0))])),formats:m.ALL_FORMATS});
    try {
      const video=await input.getPrimaryVideoTrack(),audio=await input.getPrimaryAudioTrack();
      if(!video)throw new Error('Received output has no video stream.');
      let frames=0,par=null;
      for await(const sample of new m.VideoSampleSink(video).samples()) {
        try {frames++;par=sample.pixelAspectRatio} finally {sample.close()}
      }
      const width=await video.getCodedWidth(),height=await video.getCodedHeight(),pixels=[];
      const samples=new m.VideoSampleSink(video).samplesAtTimestamps(queries.map(query=>query.time));let index=0;
      try {for await(const sample of samples){
        if(!sample)throw new Error('Received output is missing a requested frame.');
        try {
          const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d');sample.draw(ctx,0,0,width,height);
          pixels.push(queries[index++].points.map(([x,y])=>[...ctx.getImageData(x,y,1,1).data]));
        }finally{sample.close()}
      }}finally{await samples.return()}
      return {duration:await input.computeDuration(),video:{codec:await video.getCodec(),width,height,frames,par,
        duration:await video.computeDuration(),fps:(await video.computeFrameRateMetrics()).bestGuessFrameRate},
        audio:audio?{codec:await audio.getCodec(),sampleRate:await audio.getSampleRate(),channels:await audio.getNumberOfChannels()}:null,pixels};
    }finally{input.dispose()}
  },{base64:bytes.toString('base64'),queries});
}
