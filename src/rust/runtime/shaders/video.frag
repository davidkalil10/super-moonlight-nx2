#version 450
#extension GL_GOOGLE_include_directive : require
#include "storage.glsl"
// Zero copy: R8 and R8G8 texel buffer views over the frame slots.
layout(set = 0, binding = 2) uniform textureBuffer lumaPlane;
layout(set = 0, binding = 3) uniform textureBuffer chromaPlane;
float lumaAt(uint offset) { return texelFetch(lumaPlane, int(offset)).r * 255.0; }
vec2 chromaAt(uint offset) { return texelFetch(chromaPlane, int(offset >> 1u)).rg * 255.0; }
#include "video.glsl"
