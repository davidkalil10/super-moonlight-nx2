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

float planeByte(uint offset){ return float((ring.words[offset>>2]>>((offset&3u)*8u))&255u); }

// Bilinear sample of one plane of the decoded frame; mirrors hbv2.cjs toRgb.
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

void main(){
 vec2 p=gl_FragCoord.xy;
 uint mode=ring.words[CONTROL_MODE];
 vec3 color;
 if(mode==MODE_HBV2){
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
 outColor=vec4(color*(1.0-c.transition.x),1);
}
