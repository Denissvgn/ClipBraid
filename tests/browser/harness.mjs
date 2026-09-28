import { test as base, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
export { expect };
export const test=base.extend({
  context:async({context},use,info)=>{
    const resources=[];const pending=[];
    context.on('response',response=>{
      const request=response.request();
      if(!['script','stylesheet'].includes(request.resourceType()))return;
      pending.push(response.body().then(body=>resources.push({url:response.url(),sha256:createHash('sha256').update(body).digest('hex'),bytes:body.length}),error=>resources.push({url:response.url(),error:String(error)})));
    });
    try{await use(context);}finally{
      await Promise.all(pending);
      await info.attach('served-resources',{body:JSON.stringify({browser:context.browser()?.version(),resources},null,2),contentType:'application/json'});
    }
  },
});
