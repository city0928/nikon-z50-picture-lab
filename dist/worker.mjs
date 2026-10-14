import {renderPixels} from './core.mjs';
self.onmessage=({data})=>{try{const pixels=renderPixels(new Uint8ClampedArray(data.pixels),data.width,data.height,data.settings);self.postMessage({id:data.id,pixels:pixels.buffer},[pixels.buffer]);}catch(error){self.postMessage({id:data.id,error:error.message});}};
