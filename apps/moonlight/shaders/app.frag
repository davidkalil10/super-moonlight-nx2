#version 450
#extension GL_GOOGLE_include_directive : require
layout(location=0) out vec4 outColor;
#define STATE_ACCESS readonly
#include "abi.glsl"
#include "text.glsl"
#include "draw.glsl"
#include "ring.glsl"
layout(set=0,binding=1,std430) readonly buffer FrameRing { uint words[]; } ring;
uint hbvWord(uint index){ return ring.words[index]; }
#include "hbv.glsl"

bool slotSequence(uint base, out uint sequence){
 sequence=ring.words[base+1u];
 if(ring.words[base]!=HBV_MAGIC||sequence==0u)return false;
 uint exchanges=(ring.words[base+3u]+RING_EXCHANGE_BYTES-1u)/RING_EXCHANGE_BYTES;
 if(exchanges==0u||exchanges>RING_SLOT_WORDS*4u/RING_EXCHANGE_BYTES)return false;
 return ring.words[base+exchanges*RING_EXCHANGE_BYTES/4u-1u]==sequence;
}

void main(){
 vec2 p=gl_FragCoord.xy;
 uint newest=RING_SLOTS,newestSequence=0u;
 for(uint i=0u;i<RING_SLOTS;i++){
  uint sequence;
  if(slotSequence(i*RING_SLOT_WORDS,sequence)&&sequence>newestSequence){newest=i;newestSequence=sequence;}
 }
 vec3 color;
 if(newest<RING_SLOTS){
  uint base=newest*RING_SLOT_WORDS,size=ring.words[base+2u];
  color=hbvSample(base,p*vec2(size&0xffffu,size>>16)/vec2(1920.0,1080.0));
 }else{
  color=vec3(.03,.05,.08);
  color=mix(color,vec3(.25,.85,.90),text(p,vec2(960-TEXT_TITLE.z/2,440),TEXT_TITLE));
  color=mix(color,vec3(.84,.91,.96),text(p,vec2(960-TEXT_WAITING.z/2,560),TEXT_WAITING));
  color=mix(color,vec3(.60,.72,.80),text(p,vec2(960-TEXT_RETURN.z/2,660),TEXT_RETURN));
 }
 outColor=vec4(color*(1.0-c.transition.x),1);
}
