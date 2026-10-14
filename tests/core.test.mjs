import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, normalize, encodeNP3, decodeNP3, toneTable, activeTable, crc32, makeCardZip, renderPixels, cameraFilename } from '../dist/core.mjs';

function records(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Map();
  let cursor = 4;
  for (;;) {
    const id = view.getUint32(cursor); cursor += 4;
    if (!id) { assert.equal(cursor, bytes.length); break; }
    const size = view.getUint32(cursor); cursor += 4;
    assert.ok(cursor + size <= bytes.length);
    assert.ok(!result.has(id));
    result.set(id, bytes.slice(cursor, cursor + size)); cursor += size;
  }
  return result;
}

test('camera export has a terminated 0300 container and no later-generation tags', () => {
  const bytes = encodeNP3(defaults());
  assert.deepEqual([...bytes.slice(0, 4)], [78, 67, 80, 0]);
  const tags = records(bytes);
  assert.equal(new TextDecoder().decode(tags.get(0x100)), '0300');
  assert.equal(tags.get(0x200).length, 20);
  assert.deepEqual([...tags.get(0x300)], [0, 1]);
  assert.ok(tags.has(0x1600));
  assert.ok(!tags.has(0x1700));
});

test('quarter-step parameters survive camera-file round trips', () => {
  const settings = {...defaults(), name:'Z50 TEST', sharpening:2.25, midSharpening:-1.5, clarity:0.75, contrast:-1.25, brightness:0.5, saturation:1.75, hue:-0.25};
  const parsed = decodeNP3(encodeNP3(settings));
  for (const key of ['name','base','sharpening','midSharpening','clarity','contrast','brightness','saturation','hue']) assert.equal(parsed[key], settings[key], key);
  assert.deepEqual([...records(encodeNP3(settings)).get(0x600)], [137, 4]);
});

test('a custom curve exports 256 bounded 15-bit entries with curve control flags', () => {
  const settings = {...defaults(), curveEnabled:true, curve:[[0,12],[64,44],[128,142],[192,223],[255,250]]};
  const tags = records(encodeNP3(settings));
  assert.deepEqual([...tags.get(0x800)], [1,4]);
  assert.deepEqual([...tags.get(0x900)], [1,4]);
  const curve = tags.get(2); assert.equal(curve.length,578);
  assert.equal(curve[0],73);
  const view = new DataView(curve.buffer,curve.byteOffset,curve.byteLength);
  const expected = toneTable(settings.curve);
  for (let i=0;i<256;i++) assert.equal(view.getUint16(66+i*2),Math.round(expected[i]/255*32767));
  assert.ok(decodeNP3(encodeNP3(settings)).curveEnabled);
});

test('linear and shaped curves pass through their control points', () => {
  const identity = toneTable([[0,0],[255,255]]);
  for(let i=0;i<256;i++) assert.equal(identity[i],i);
  const curved = toneTable([[0,4],[128,160],[255,250]]);
  assert.equal(curved[0],4); assert.equal(curved[128],160); assert.equal(curved[255],250);
});

test('invalid camera names, unsafe slots, non-finite and unsupported parameter values are rejected', () => {
  for(const patch of [{name:'中文'},{name:'A'.repeat(20)},{name:'bad\nname'},{slot:0},{slot:100},{slot:1.2},{clarity:Infinity},{hue:3.25},{brightness:0.1},{base:'FlexibleColor'}]) assert.throws(()=>normalize({...defaults(),...patch}));
  assert.equal(cameraFilename({...defaults(),slot:7}),'PICCON07.NP3');
});

test('duplicate curve inputs and incomplete endpoints are rejected', () => {
  for(const curve of [[[0,0],[0,10],[255,255]],[[1,0],[255,255]],[[0,0],[254,255]],[[0,0],[128,NaN],[255,255]]]) assert.throws(()=>toneTable(curve));
});

test('truncated and flexible-color files fail without importing partial state', () => {
  const bytes=encodeNP3(defaults());
  assert.throws(()=>decodeNP3(bytes.slice(0,-2)));
  const future=bytes.slice(); future.set(new TextEncoder().encode('0310'),12);
  assert.throws(()=>decodeNP3(future),/0300/);
  const corrupt=bytes.slice(); new DataView(corrupt.buffer).setUint32(8,0xffffffff);
  assert.throws(()=>decodeNP3(corrupt));
});

test('CRC matches the standard known vector and SD ZIP has the intended path', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
  const settings={...defaults(),slot:7};
  const np3=encodeNP3(settings); const zip=makeCardZip(settings);
  const view=new DataView(zip.buffer);
  assert.equal(view.getUint32(0,true),0x04034b50);
  assert.equal(view.getUint32(14,true),crc32(np3));
  const length=view.getUint16(26,true);
  assert.equal(new TextDecoder().decode(zip.slice(30,30+length)),'NIKON/CUSTOMPC/PICCON07.NP3');
  assert.deepEqual(zip.slice(30+length,30+length+np3.length),np3);
  assert.equal(view.getUint32(zip.length-22,true),0x06054b50);
});

test('neutral zero adjustments preserve pixels, alpha and source memory', () => {
  const source=new Uint8ClampedArray([0,0,0,255,120,180,220,100,255,255,255,50,30,80,130,255]);
  const before=source.slice();
  const result=renderPixels(source,2,2,{...defaults(),base:'neutral',sharpening:0,midSharpening:0,clarity:0});
  assert.deepEqual(result,source); assert.deepEqual(source,before); assert.notEqual(result,source);
});

test('monochrome preview has equal RGB channels and preserves transparency', () => {
  const source=new Uint8ClampedArray([160,80,40,77,20,120,220,128]);
  const result=renderPixels(source,2,1,{...defaults(),base:'monochrome',sharpening:0});
  for(let i=0;i<result.length;i+=4){assert.equal(result[i],result[i+1]);assert.equal(result[i],result[i+2]);assert.equal(result[i+3],source[i+3]);}
  const tags=records(encodeNP3({...defaults(),base:'monochrome',filter:2}));
  assert.deepEqual([...tags.get(0xa00)],[255,4]);
  assert.deepEqual([...tags.get(0xc00)],[130,0]);
});

test('modern exposure and brightness alter the exported curve rather than disappearing from NP3', () => {
  const settings={...defaults(),base:'neutral',sharpening:0,tone:{exposure:1,brightness:15}};
  const tags=records(encodeNP3(settings));
  assert.ok(tags.has(2),'modern controls must activate camera curve export');
  assert.deepEqual([...tags.get(0x800)],[1,4]);
  assert.deepEqual([...tags.get(0x900)],[1,4]);
  const table=activeTable(settings),decoded=decodeNP3(encodeNP3(settings));
  assert.ok(table[128]>160);
  const source=new Uint8ClampedArray([128,128,128,77]);
  assert.equal(renderPixels(source,1,1,settings)[0],Math.round(table[128]));
  for(let i=0;i<256;i++)assert.ok(Math.abs(decoded.curveTable[i]-table[i])<255/32767);
  assert.equal(decoded.tone.exposure,0,'import retains the baked LUT without applying exposure twice');
  assert.deepEqual(encodeNP3(decoded),encodeNP3(settings));
});

test('highlights, shadows, white and black controls affect their intended tonal ranges', () => {
  const lut=patch=>activeTable({...defaults(),base:'neutral',tone:patch});
  assert.ok(lut({shadows:60})[32]>32);
  assert.equal(lut({shadows:60})[220],220);
  assert.ok(lut({highlights:-60})[220]<220);
  assert.equal(lut({highlights:-60})[32],32);
  assert.ok(lut({blacks:50})[0]>0);
  assert.equal(lut({blacks:50})[255],255);
  assert.ok(lut({whites:-50})[255]<255);
  assert.equal(lut({whites:-50})[0],0);
  assert.ok(lut({contrast:40})[64]<64);
  assert.ok(lut({contrast:40})[192]>192);
});

test('modern settings validate ranges and keep old presets and zero adjustments unchanged', () => {
  const old={...defaults()};delete old.tone;
  const normalized=normalize(old);
  assert.equal(normalized.tone.exposure,0);
  assert.deepEqual(encodeNP3(old),encodeNP3({...old,tone:{exposure:0,brightness:0,contrast:0,highlights:0,shadows:0,whites:0,blacks:0}}));
  assert.ok(!records(encodeNP3(old)).has(2));
  for(const tone of [{exposure:3.1},{exposure:.15},{whites:101},{blacks:NaN},{brightness:1.5},null,[],{hsl:10}])assert.throws(()=>normalize({...old,tone}));
});

test('combined modern adjustments export bounded values and preserve manual and imported curves', () => {
  const settings={...defaults(),curveEnabled:true,curve:[[0,10],[128,145],[255,247]],tone:{exposure:-.7,brightness:12,contrast:22,highlights:-50,shadows:35,whites:10,blacks:-15}};
  const before=structuredClone(settings),table=activeTable(settings),tags=records(encodeNP3(settings));
  const view=new DataView(tags.get(2).buffer);
  for(let i=0;i<256;i++){assert.ok(table[i]>=0&&table[i]<=255);assert.equal(view.getUint16(66+i*2),Math.round(table[i]*32767/255));}
  assert.deepEqual(settings,before);
  const imported=decodeNP3(encodeNP3(settings));
  assert.deepEqual(activeTable(imported),Float64Array.from(imported.curveTable));
  assert.ok(activeTable({...imported,tone:{shadows:20}})[32]>imported.curveTable[32]);
});

test('modern tone composition retains existing native brightness and contrast unless a manual curve replaces them', () => {
  const base={...defaults(),base:'neutral',sharpening:0,contrast:1.25,brightness:.5,tone:{exposure:.2}};
  const adjusted=activeTable(base),plain=activeTable({...base,contrast:0,brightness:0});
  assert.ok(adjusted[180]>plain[180]);
  const custom={...base,curveEnabled:true};
  assert.deepEqual(activeTable(custom),activeTable({...custom,contrast:0,brightness:0}));
  const source=new Uint8ClampedArray([180,180,180,255]);
  assert.equal(renderPixels(source,1,1,base)[0],Math.round(adjusted[180]));
});

test('extreme tone settings keep every exported curve entry finite and bounded', () => {
  for(const sign of [-1,1]){
    const settings={...defaults(),tone:{exposure:sign*3,brightness:sign*100,contrast:sign*100,highlights:sign*100,shadows:sign*100,whites:sign*100,blacks:sign*100}};
    assert.ok([...activeTable(settings)].every(v=>Number.isFinite(v)&&v>=0&&v<=255));
    assert.doesNotThrow(()=>decodeNP3(encodeNP3(settings)));
  }
});

test('tone activation uses the visible manual contrast while preserving automatic contrast for tone reset', () => {
  const settings={...defaults(),contrast:3,autoContrast:true,tone:{exposure:.1}};
  assert.deepEqual(encodeNP3(settings),encodeNP3({...settings,autoContrast:false}),'automatic contrast is unavailable in curve mode, so the visible manual contrast must be baked');
  assert.ok(activeTable(settings)[64]<activeTable({...settings,contrast:0})[64]);
  assert.equal(settings.autoContrast,true,'original auto preference remains intact');
  const reset={...settings,tone:defaults().tone};
  const tags=records(encodeNP3(reset));
  assert.deepEqual([...tags.get(0x800)],[0,4],'tone reset restores native automatic contrast');
  assert.ok(!tags.has(2));
});
