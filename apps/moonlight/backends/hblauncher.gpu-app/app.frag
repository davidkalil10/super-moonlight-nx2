#version 450
#extension GL_GOOGLE_include_directive : require
layout(location=0) out vec4 outColor;
#define STATE_ACCESS readonly
#include "abi.glsl"
#include "text.glsl"
#include "draw.glsl"
#include "ring.glsl"
layout(set=0,binding=1,std430) readonly buffer PrivateMemory { uint words[]; } ring;
uint hbvWord(uint index){ return ring.words[index]; }
#include "hbv.glsl"
uint uiWord(uint index){ return ring.words[index]; }
#include "ui.glsl"

float planeByte(uint offset){ return float((ring.words[offset>>2]>>((offset&3u)*8u))&255u); }

// Bilinear sample of one plane of the decoded frame; mirrors tools/moonlight/hbv2.js toRgb.
float planeSample(uint base,uint stride,uvec2 size,vec2 s){
 vec2 q=s-0.5,f=q-floor(q);
 ivec2 i=ivec2(floor(q)),hi=ivec2(size)-1;
 uint x0=uint(clamp(i.x,0,hi.x)),x1=uint(clamp(i.x+1,0,hi.x));
 uint r0=base+uint(clamp(i.y,0,hi.y))*stride,r1=base+uint(clamp(i.y+1,0,hi.y))*stride;
 return mix(mix(planeByte(r0+x0),planeByte(r0+x1),f.x),mix(planeByte(r1+x0),planeByte(r1+x1),f.x),f.y);
}

vec3 hbv2Sample(vec2 p){
 uint size=ring.words[CONTROL_SIZE],frame=FRAMES_OFFSET+ring.words[CONTROL_CURRENT]*FRAME_BYTES;
 uvec2 luma=uvec2(size&0xffffu,size>>16),chroma=luma/2u;
 vec2 s=p*float(luma.x)/1920.0;
 float y=planeSample(frame,FRAME_STRIDE,luma,s);
 float cb=planeSample(frame+FRAME_LUMA_BYTES,FRAME_STRIDE/2u,chroma,s/2.0)-128.0;
 float cr=planeSample(frame+FRAME_LUMA_BYTES+FRAME_CHROMA_BYTES,FRAME_STRIDE/2u,chroma,s/2.0)-128.0;
 vec3 rgb=vec3(y+1.402*cr,y-0.344136*cb-0.714136*cr,y+1.772*cb);
 return clamp(rgb/255.0,0.0,1.0);
}

float nativeChroma(uint base,uint stride,uvec2 size,vec2 s,uint channel){
 vec2 q=s-0.5,f=q-floor(q);
 ivec2 i=ivec2(floor(q)),hi=ivec2(size)-1;
 uint x0=uint(clamp(i.x,0,hi.x))*2u+channel,x1=uint(clamp(i.x+1,0,hi.x))*2u+channel;
 uint r0=base+uint(clamp(i.y,0,hi.y))*stride,r1=base+uint(clamp(i.y+1,0,hi.y))*stride;
 return mix(mix(planeByte(r0+x0),planeByte(r0+x1),f.x),mix(planeByte(r1+x0),planeByte(r1+x1),f.x),f.y);
}

vec3 nativeSample(vec2 p){
 uint packed=ring.words[CONTROL_SIZE],stride=ring.words[CONTROL_CURRENT_STRIDE];
 uvec2 size=uvec2(packed&0xffffu,packed>>16);
 float scale=min(1920.0/float(size.x),1080.0/float(size.y));
 vec2 s=(p-(vec2(1920,1080)-vec2(size)*scale)*0.5)/scale;
 if(any(lessThan(s,vec2(0)))||any(greaterThanEqual(s,vec2(size))))return vec3(0);
 uint frame=FRAMES_OFFSET+ring.words[CONTROL_CURRENT]*FRAME_BYTES;
 uint chroma=frame+stride*ring.words[CONTROL_CURRENT_SLICE_HEIGHT];
 float y=(planeSample(frame,stride,size,s)-16.0)/219.0;
 float cb=(nativeChroma(chroma,stride,size/2u,s/2.0,0u)-128.0)/224.0;
 float cr=(nativeChroma(chroma,stride,size/2u,s/2.0,1u)-128.0)/224.0;
 vec3 rgb=ring.words[CONTROL_CURRENT_COLOR]==1u?vec3(y+1.5748*cr,y-0.187324*cb-0.468124*cr,y+1.8556*cb):vec3(y+1.402*cr,y-0.344136*cb-0.714136*cr,y+1.772*cb);
 return clamp(rgb,0.0,1.0);
}

void main(){
 vec2 p=gl_FragCoord.xy;
 uint mode=ring.words[CONTROL_MODE];
 bool page=uiShowsPage(),overlay=page&&(ring.words[uiShownBase()+UI_HDR_FLAGS]&UI_FLAG_OVERLAY)!=0u;
 vec3 color;
 if(page&&!overlay){
  color=uiDraw(p,vec3(0),float(c.state.z));
 }else if(mode==MODE_NATIVE){
  color=nativeSample(p);
 }else if(mode==MODE_HBV2){
  color=hbv2Sample(p);
 }else if(mode==MODE_HBV1){
  uint base=RING_BASE+ring.words[CONTROL_HBV1_SLOT]*RING_SLOT_WORDS,size=ring.words[base+2u];
  color=hbvSample(base,p*float(size&0xffffu)/1920.0);
 }else{
  color=vec3(.03,.05,.08);
  color=mix(color,vec3(.25,.85,.90),text(p,vec2(960-TEXT_TITLE.z/2,440),TEXT_TITLE));
  color=mix(color,vec3(.84,.91,.96),text(p,vec2(960-TEXT_WAITING.z/2,560),TEXT_WAITING));
  color=mix(color,vec3(.60,.72,.80),text(p,vec2(960-TEXT_RETURN.z/2,660),TEXT_RETURN));
 }
 if(overlay)color=uiDraw(p,color*.35,float(c.state.z));
 outColor=vec4(color*(1.0-c.transition.x),1);
}
