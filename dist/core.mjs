// Independently implemented from observed Nikon tagged-file layouts.
// Format reference: https://github.com/tvgenious89/nikon-pc ; no third-party code copied.
export const PROFILES = Object.freeze({standard:{id:0x0001,label:'标准'},neutral:{id:0x03c2,label:'自然'},vivid:{id:0x00c3,label:'鲜艳'},portrait:{id:0x0486,label:'人像'},landscape:{id:0x04c7,label:'风景'},monochrome:{id:0x064d,label:'单色'}});
export const PARAMETERS = Object.freeze({sharpening:{label:'锐化',min:-3,max:9,tag:0x600},midSharpening:{label:'中等范围锐化',min:-3,max:3,tag:0x1600},clarity:{label:'清晰度',min:-5,max:5,tag:0x700},contrast:{label:'对比度',min:-3,max:3,tag:0x800},brightness:{label:'亮度',min:-1.5,max:1.5,tag:0x900},saturation:{label:'饱和度',min:-3,max:3,tag:0xa00},hue:{label:'色相',min:-3,max:3,tag:0xb00}});
export const TONE_PARAMETERS = Object.freeze({exposure:{label:'曝光',min:-3,max:3,step:.1,unit:'EV',hint:'通过曲线模拟曝光明暗，不改变相机拍摄曝光'},brightness:{label:'亮度',min:-100,max:100,step:1,hint:'调整中间调，保留黑白端点'},contrast:{label:'对比度',min:-100,max:100,step:1,hint:'拉开或压缩中间调反差'},highlights:{label:'高光',min:-100,max:100,step:1,hint:'调整明亮区域'},shadows:{label:'阴影',min:-100,max:100,step:1,hint:'调整暗部区域'},whites:{label:'白色',min:-100,max:100,step:1,hint:'调整白点与最亮区域'},blacks:{label:'黑色',min:-100,max:100,step:1,hint:'调整黑点与最暗区域'}});
const clamp=(n,min=0,max=255)=>Math.min(max,Math.max(min,n));
export function defaults(){return {name:'Z50 CUSTOM 01',slot:1,base:'standard',sharpening:3,midSharpening:0,clarity:0,contrast:0,brightness:0,saturation:0,hue:0,filter:0,autoSharpening:false,autoContrast:false,autoSaturation:false,curveEnabled:false,curve:[[0,0],[64,64],[128,128],[192,192],[255,255]],curveTable:null,tone:Object.fromEntries(Object.keys(TONE_PARAMETERS).map(key=>[key,0]))};}
function pointsChecked(points){
  if(!Array.isArray(points)||points.length<2||points.length>20)throw new Error('曲线需要 2–20 个控制点');
  const copy=points.map(p=>{if(!Array.isArray(p)||p.length!==2||!p.every(v=>Number.isFinite(v)&&v>=0&&v<=255))throw new Error('曲线坐标必须位于 0–255');return [...p];});
  if(copy[0][0]!==0||copy.at(-1)[0]!==255||copy.some((p,i)=>i>0&&p[0]<=copy[i-1][0]))throw new Error('曲线输入必须从 0 到 255 严格递增');
  return copy;
}
export function normalize(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('预设格式无效');
  const d=defaults(), s={};
  for(const key of Object.keys(d))s[key]=input[key]===undefined?d[key]:input[key];
  if(typeof s.name!=='string'||!s.name.trim()||!/^[\x20-\x7e]{1,19}$/.test(s.name))throw new Error('机内名称需为 1–19 个英文、数字或 ASCII 符号');
  if(!Number.isInteger(s.slot)||s.slot<1||s.slot>99)throw new Error('文件编号必须是 1–99 的整数');
  if(!Object.hasOwn(PROFILES,s.base))throw new Error('这个基础优化校准不受当前 Z50 导出器支持');
  for(const [key,range]of Object.entries(PARAMETERS))if(!Number.isFinite(s[key])||s[key]<range.min||s[key]>range.max||Math.abs(s[key]*4-Math.round(s[key]*4))>1e-8)throw new Error(`${range.label}需在 ${range.min}–${range.max} 之间，以 0.25 为步长`);
  if(!Number.isInteger(s.filter)||s.filter<0||s.filter>4)throw new Error('单色滤镜选项无效');
  for(const key of ['autoSharpening','autoContrast','autoSaturation','curveEnabled'])if(typeof s[key]!=='boolean')throw new Error('预设开关格式无效');
  if(!s.tone||typeof s.tone!=='object'||Array.isArray(s.tone)||Object.keys(s.tone).some(key=>!Object.hasOwn(TONE_PARAMETERS,key)))throw new Error('影调调整格式无效');
  s.tone=Object.fromEntries(Object.entries(TONE_PARAMETERS).map(([key,r])=>{const v=s.tone[key]===undefined?0:s.tone[key];if(!Number.isFinite(v)||v<r.min||v>r.max||Math.abs(v/r.step-Math.round(v/r.step))>1e-8)throw new Error(`${r.label}需在 ${r.min}–${r.max} 之间，以 ${r.step} 为步长`);return[key,v];}));
  s.curve=pointsChecked(s.curve);
  if(s.curveTable!==null){if(!Array.isArray(s.curveTable)||s.curveTable.length!==256||!s.curveTable.every(v=>Number.isFinite(v)&&v>=0&&v<=255))throw new Error('导入曲线表无效');s.curveTable=[...s.curveTable];}
  return s;
}
export function toneTable(points){
  const p=pointsChecked(points),table=new Float64Array(256);let segment=0;
  for(let x=0;x<256;x++){while(segment<p.length-2&&x>p[segment+1][0])segment++;const[a,b]=[p[segment],p[segment+1]];table[x]=a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]);}
  return table;
}
export function hasTone(s){return Object.keys(TONE_PARAMETERS).some(key=>s.tone?.[key]);}
export function usesCurve(s){return s.curveEnabled||hasTone(s);}
export function manualTable(s){return s.curveTable?Float64Array.from(s.curveTable):toneTable(s.curve);}
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
// All modern tone controls are one-dimensional mappings, so the exact same
// composed LUT can be stored in a classic NP3 instead of preview-only state.
export function activeTable(input){
  const s=normalize(input),t=s.tone,modern=hasTone(s),nativeContrast=Math.pow(1.12,s.autoContrast&&!modern?0:s.contrast),table=s.curveEnabled?manualTable(s):Float64Array.from({length:256},(_,i)=>clamp((i-127.5)*nativeContrast+127.5+s.brightness*18));
  if(!modern)return table;
  for(let i=0;i<256;i++){
    let y=table[i]/255;
    if(t.exposure){const linear=y<=.04045?y/12.92:Math.pow((y+.055)/1.055,2.4),exposed=clamp(linear*Math.pow(2,t.exposure),0,1);y=exposed<=.0031308?exposed*12.92:1.055*Math.pow(exposed,1/2.4)-.055;}
    if(t.brightness)y=Math.pow(y,Math.pow(2,-t.brightness/150));
    if(t.contrast){const power=Math.pow(2,t.contrast/100),lo=Math.pow(y,power),hi=Math.pow(1-y,power);y=lo/(lo+hi);}
    if(t.shadows)y=clamp(y+t.shadows/100*.7*y*(1-smooth(.25,.65,y)),0,1);
    if(t.highlights)y=clamp(y+t.highlights/100*.7*(1-y)*smooth(.35,.75,y),0,1);
    if(t.whites)y=clamp(y+t.whites/100*.25*smooth(.45,1,y),0,1);
    if(t.blacks)y=clamp(y+t.blacks/100*.2*(1-smooth(0,.55,y)),0,1);
    table[i]=clamp(y*255);
  }
  return table;
}
export function cameraFilename(s){return `PICCON${String(normalize(s).slot).padStart(2,'0')}.NP3`;}
function record(id,payload){const b=new Uint8Array(8+payload.length);const d=new DataView(b.buffer);d.setUint32(0,id);d.setUint32(4,payload.length);b.set(payload,8);return b;}
function joined(parts){const result=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const p of parts){result.set(p,offset);offset+=p.length;}return result;}
const text=s=>new TextEncoder().encode(s);
export function encodeNP3(input){
  const s=normalize(input), mono=s.base==='monochrome', curveMode=usesCurve(s), parts=[new Uint8Array([78,67,80,0])];
  const values=new Map([[0x100,text('0300')],[0x200,new Uint8Array(20)],[0x300,new Uint8Array([PROFILES[s.base].id>>8,PROFILES[s.base].id&255])],[0x400,new Uint8Array([0,0])],[0x500,new Uint8Array([255,1])]]);
  values.get(0x200).set(text(s.name));
  for(const [key,{tag}]of Object.entries(PARAMETERS)){
    let value=128+Math.round(s[key]*4);
    if((key==='contrast'||key==='brightness')&&curveMode)value=1;
    else if((key==='sharpening'&&s.autoSharpening)||(key==='contrast'&&s.autoContrast)||(key==='saturation'&&s.autoSaturation))value=0;
    if(mono&&(key==='saturation'||key==='hue'))value=255;
    values.set(tag,new Uint8Array([value,4]));
  }
  values.set(0xc00,new Uint8Array([mono?128+s.filter:255,0]));
  values.set(0xd00,new Uint8Array([mono?128:255,0]));values.set(0xe00,new Uint8Array([255,4]));
  for(let tag=0xf00;tag<=0x1400;tag+=0x100)values.set(tag,new Uint8Array([255,1]));
  values.set(0x1500,new Uint8Array([255,10]));
  for(const [id,payload]of [...values].sort((a,b)=>a[0]-b[0]))parts.push(record(id,payload));
  if(curveMode){const body=new Uint8Array(578);body.set([73,48,0,255,0,255,1,0,0]);const view=new DataView(body.buffer), lut=activeTable(s);for(let i=0;i<256;i++)view.setUint16(66+i*2,Math.round(lut[i]*32767/255));parts.push(record(2,body));}
  parts.push(new Uint8Array(4));return joined(parts);
}
export function decodeNP3(input){
  const b=input instanceof Uint8Array?input:new Uint8Array(input);
  if(b.length<16||b.length>16384||b[0]!==78||b[1]!==67||b[2]!==80||b[3]!==0)throw new Error('这不是支持的 NP3 文件');
  const view=new DataView(b.buffer,b.byteOffset,b.byteLength), tags=new Map();let offset=4, ended=false;
  while(offset+4<=b.length){const id=view.getUint32(offset);offset+=4;if(id===0){ended=true;break;}if(offset+4>b.length)throw new Error('文件头被截断');const size=view.getUint32(offset);offset+=4;if(size>b.length-offset||tags.has(id)||tags.size>=40)throw new Error('预设记录长度或编号无效');tags.set(id,b.slice(offset,offset+size));offset+=size;}
  if(!ended||offset!==b.length)throw new Error('预设文件结尾无效');
  if(new TextDecoder().decode(tags.get(0x100))!=='0300')throw new Error('第一代 Z50 调试器仅加载经典 NP3 0300；不加载 Flexible Color / 0310 配置');
  for(const id of tags.keys())if(id>=0x1700)throw new Error('这个文件包含当前导出器不支持的高级色彩设置');
  function field(id,length){const data=tags.get(id);if(!data||data.length!==length)throw new Error('预设缺少必要字段');return data;}
  const result=defaults(),n=field(0x200,20);result.name=new TextDecoder().decode(n).split('\0')[0];
  const base=field(0x300,2),enumValue=(base[0]<<8)|base[1];result.base=Object.keys(PROFILES).find(k=>PROFILES[k].id===enumValue);if(!result.base)throw new Error('不支持此基础优化校准');
  for(const [key,{tag}]of Object.entries(PARAMETERS)){
    const v=field(tag,2);if(v[1]!==4)throw new Error('不支持此参数编码');
    if(v[0]===0){const autoKey={sharpening:'autoSharpening',contrast:'autoContrast',saturation:'autoSaturation'}[key];if(!autoKey)throw new Error('自动参数无效');result[autoKey]=true;result[key]=key==='sharpening'?3:0;}
    else if(v[0]===1&&(key==='contrast'||key==='brightness')){result.curveEnabled=true;result[key]=0;}
    else if(v[0]===255&&(key==='saturation'||key==='hue'))result[key]=0;
    else result[key]=(v[0]-128)/4;
  }
  if(result.base==='monochrome'){result.filter=field(0xc00,2)[0]-128;const toning=field(0xd00,2)[0];if(toning!==128)throw new Error('该单色预设含有调色效果；当前版本只支持中性黑白，未导入以免丢失设置');}
  const curve=tags.get(2);
  if(result.curveEnabled&&!curve)throw new Error('文件声明了曲线但缺少曲线数据');
  if(curve){if(curve.length!==578||curve[0]!==73)throw new Error('曲线记录无效');const data=new DataView(curve.buffer,curve.byteOffset,curve.byteLength);result.curveEnabled=true;result.curveTable=Array.from({length:256},(_,i)=>{const v=data.getUint16(66+i*2);if(v>32767)throw new Error('曲线超出 15 位范围');return v*255/32767;});result.curve=[0,64,128,192,255].map(x=>[x,result.curveTable[x]]);}
  return normalize(result);
}
export function crc32(bytes){let sum=0xffffffff;for(const byte of bytes){sum^=byte;for(let bit=0;bit<8;bit++)sum=(sum>>>1)^((sum&1)?0xedb88320:0);}return (sum^0xffffffff)>>>0;}
export function makeCardZip(input){
  const s=normalize(input),content=encodeNP3(s),path=text(`NIKON/CUSTOMPC/${cameraFilename(s)}`),checksum=crc32(content);
  const local=new Uint8Array(30+path.length),l=new DataView(local.buffer);l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x800,true);l.setUint16(12,0x21,true);l.setUint32(14,checksum,true);l.setUint32(18,content.length,true);l.setUint32(22,content.length,true);l.setUint16(26,path.length,true);local.set(path,30);
  const central=new Uint8Array(46+path.length),c=new DataView(central.buffer);c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint16(14,0x21,true);c.setUint32(16,checksum,true);c.setUint32(20,content.length,true);c.setUint32(24,content.length,true);c.setUint16(28,path.length,true);central.set(path,46);
  const end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,1,true);e.setUint16(10,1,true);e.setUint32(12,central.length,true);e.setUint32(16,local.length+content.length,true);return joined([local,content,central,end]);
}
function blur(source,width,height,radius){
  const temp=new Float32Array(source.length),out=new Float32Array(source.length),diameter=radius*2+1;
  for(let y=0;y<height;y++)for(let ch=0;ch<3;ch++){let sum=0;for(let x=-radius;x<=radius;x++)sum+=source[(y*width+clamp(x,0,width-1))*4+ch];for(let x=0;x<width;x++){temp[(y*width+x)*4+ch]=sum/diameter;sum+=source[(y*width+clamp(x+radius+1,0,width-1))*4+ch]-source[(y*width+clamp(x-radius,0,width-1))*4+ch];}}
  for(let x=0;x<width;x++)for(let ch=0;ch<3;ch++){let sum=0;for(let y=-radius;y<=radius;y++)sum+=temp[(clamp(y,0,height-1)*width+x)*4+ch];for(let y=0;y<height;y++){out[(y*width+x)*4+ch]=sum/diameter;sum+=temp[(clamp(y+radius+1,0,height-1)*width+x)*4+ch]-temp[(clamp(y-radius,0,height-1)*width+x)*4+ch];}}
  return out;
}
export function renderPixels(source,width,height,input){
  const s=normalize(input);if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>8000000||source.length!==width*height*4)throw new Error('图像尺寸无效');
  const curveMode=usesCurve(s),out=Float32Array.from(source),curve=curveMode?activeTable(s):null;
  const looks={standard:[1.025,1.05],neutral:[1,1],vivid:[1.09,1.18],portrait:[0.97,0.96],landscape:[1.065,1.13],monochrome:[1,1]};
  const[baseContrast,baseSat]=looks[s.base],contrast=curveMode?1:Math.pow(1.12,s.autoContrast?0:s.contrast),lift=curveMode?0:s.brightness*18,sat=baseSat*Math.pow(1.18,s.autoSaturation?0:s.saturation),angle=s.hue*Math.PI/36;
  const cos=Math.cos(angle),sin=Math.sin(angle),weights=[[.2126,.7152,.0722],[.35,.59,.06],[.48,.48,.04],[.62,.34,.04],[.18,.76,.06]][s.filter];
  for(let i=0;i<out.length;i+=4){
    let rgb=[out[i],out[i+1],out[i+2]].map(v=>{v=clamp((v-127.5)*baseContrast+127.5);return curve?curve[Math.round(v)]:clamp((v-127.5)*contrast+127.5+lift);});
    if(s.base==='monochrome'){const gray=rgb.reduce((v,ch,j)=>v+ch*weights[j],0);rgb=[gray,gray,gray];}
    else if(sat!==1||s.hue!==0){const[r,g,b]=rgb,y=.299*r+.587*g+.114*b,iq=.596*r-.274*g-.322*b,qq=.211*r-.523*g+.312*b;const ni=(iq*cos-qq*sin)*sat,nq=(iq*sin+qq*cos)*sat;rgb=[y+.956*ni+.621*nq,y-.272*ni-.647*nq,y-1.106*ni+1.703*nq];}
    for(let ch=0;ch<3;ch++)out[i+ch]=clamp(rgb[ch]);
  }
  const detail=[[s.clarity/10,Math.max(2,Math.round(Math.min(width,height)/55))],[s.midSharpening/8,3],[(s.autoSharpening?3:s.sharpening)/12,1]];
  for(const[amount,radius]of detail){if(!amount)continue;const softened=blur(out,width,height,radius);for(let i=0;i<out.length;i++)if(i%4!==3)out[i]=clamp(out[i]+amount*(out[i]-softened[i]));}
  return new Uint8ClampedArray(out);
}
