// Desktop Vulkan stand-in for the console's gpu-app loop, for the Moonlight
// app: binding 0 is the 8 MiB state + data buffer, binding 1 the private
// memory, and each frame is one compute dispatch (1,1,1), a barrier and a
// full-screen draw at 1920x1080, like the launcher's prerecorded command
// buffer.
//
//   gpu-check SHADER_DIR STATE DATA MEMORY OUT_DIR [PATCH...]
//
// Runs one frame, then for each PATCH (u32 byte offset + bytes) writes it into
// private memory and runs another frame. Writes OUT_DIR/state.bin (first 1 KiB
// of binding 0), OUT_DIR/memory.bin and OUT_DIR/frame.rgba (last frame), and
// prints the GPU time per frame as JSON.
#include <vulkan/vulkan.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define CHECK(x)                                                     \
  do {                                                               \
    if (!(x)) {                                                      \
      fprintf(stderr, "gpu-check: failed at %d: %s\n", __LINE__, #x); \
      exit(1);                                                       \
    }                                                                \
  } while (0)
#define VK(x) CHECK((x) == VK_SUCCESS)

enum { WIDTH = 1920, HEIGHT = 1080, STATE_BUFFER_BYTES = 8 << 20 };

typedef struct {
  VkBuffer buffer;
  VkDeviceMemory memory;
  uint8_t *mapped;
  size_t size;
} Buffer;

static VkPhysicalDevice physical;
static VkDevice device;

static void *readFile(const char *name, size_t *size) {
  FILE *f = fopen(name, "rb");
  CHECK(f);
  CHECK(!fseek(f, 0, SEEK_END));
  *size = (size_t)ftell(f);
  rewind(f);
  void *bytes = malloc(*size ? *size : 1);
  CHECK(bytes && fread(bytes, 1, *size, f) == *size);
  fclose(f);
  return bytes;
}

static void writeFile(const char *dir, const char *name, const void *bytes, size_t size) {
  char path[4096];
  snprintf(path, sizeof path, "%s/%s", dir, name);
  FILE *f = fopen(path, "wb");
  CHECK(f && fwrite(bytes, 1, size, f) == size);
  fclose(f);
}

static uint32_t memoryType(uint32_t bits, uint32_t flags) {
  VkPhysicalDeviceMemoryProperties properties;
  vkGetPhysicalDeviceMemoryProperties(physical, &properties);
  for (uint32_t i = 0; i < properties.memoryTypeCount; i++)
    if ((bits & (1u << i)) && (properties.memoryTypes[i].propertyFlags & flags) == flags) return i;
  CHECK(0);
  return 0;
}

static VkDeviceMemory allocate(VkMemoryRequirements requirements, uint32_t flags) {
  VkMemoryAllocateInfo info = {.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
                               .allocationSize = requirements.size,
                               .memoryTypeIndex = memoryType(requirements.memoryTypeBits, flags)};
  VkDeviceMemory memory;
  VK(vkAllocateMemory(device, &info, 0, &memory));
  return memory;
}

// Host-visible and coherent, like the console's private storage.
static Buffer createBuffer(size_t size, VkBufferUsageFlags usage) {
  Buffer b = {.size = size};
  VkBufferCreateInfo info = {.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
                             .size = size,
                             .usage = usage,
                             .sharingMode = VK_SHARING_MODE_EXCLUSIVE};
  VK(vkCreateBuffer(device, &info, 0, &b.buffer));
  VkMemoryRequirements requirements;
  vkGetBufferMemoryRequirements(device, b.buffer, &requirements);
  b.memory = allocate(requirements, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT |
                                        VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
  VK(vkBindBufferMemory(device, b.buffer, b.memory, 0));
  VK(vkMapMemory(device, b.memory, 0, size, 0, (void **)&b.mapped));
  memset(b.mapped, 0, size);
  return b;
}

static VkShaderModule shader(const char *dir, const char *stage) {
  char path[4096];
  snprintf(path, sizeof path, "%s/app.%s.spv", dir, stage);
  size_t size;
  void *code = readFile(path, &size);
  VkShaderModuleCreateInfo info = {.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
                                   .codeSize = size,
                                   .pCode = code};
  VkShaderModule module;
  VK(vkCreateShaderModule(device, &info, 0, &module));
  free(code);
  return module;
}

static void memoryBarrier(VkCommandBuffer cmd, VkPipelineStageFlags from, VkAccessFlags fromAccess,
                          VkPipelineStageFlags to, VkAccessFlags toAccess) {
  VkMemoryBarrier barrier = {.sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
                             .srcAccessMask = fromAccess,
                             .dstAccessMask = toAccess};
  vkCmdPipelineBarrier(cmd, from, to, 0, 1, &barrier, 0, 0, 0, 0);
}

int main(int argc, char **argv) {
  CHECK(argc >= 6);
  const char *shaderDir = argv[1], *outDir = argv[5];
  size_t stateSize, dataSize, memorySize;
  uint8_t *state = readFile(argv[2], &stateSize), *data = readFile(argv[3], &dataSize),
          *initial = readFile(argv[4], &memorySize);
  CHECK(stateSize == 1024 && 1024 + dataSize <= STATE_BUFFER_BYTES);

  VkApplicationInfo app = {.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
                           .pApplicationName = "HBLauncher Moonlight check",
                           .apiVersion = VK_API_VERSION_1_0};
  VkInstanceCreateInfo instanceInfo = {.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
                                       .pApplicationInfo = &app};
  VkInstance instance;
  VK(vkCreateInstance(&instanceInfo, 0, &instance));
  uint32_t count = 1;
  VkResult enumerated = vkEnumeratePhysicalDevices(instance, &count, &physical);
  CHECK((enumerated == VK_SUCCESS || enumerated == VK_INCOMPLETE) && count == 1);
  VkQueueFamilyProperties families[64];
  count = 64;
  vkGetPhysicalDeviceQueueFamilyProperties(physical, &count, families);
  uint32_t family = 0;
  const VkQueueFlags wanted = VK_QUEUE_GRAPHICS_BIT | VK_QUEUE_COMPUTE_BIT;
  while (family < count && (families[family].queueFlags & wanted) != wanted) family++;
  CHECK(family < count);
  float priority = 1;
  VkDeviceQueueCreateInfo queueInfo = {.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
                                       .queueFamilyIndex = family,
                                       .queueCount = 1,
                                       .pQueuePriorities = &priority};
  VkDeviceCreateInfo deviceInfo = {.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
                                   .queueCreateInfoCount = 1,
                                   .pQueueCreateInfos = &queueInfo};
  VK(vkCreateDevice(physical, &deviceInfo, 0, &device));
  VkQueue queue;
  vkGetDeviceQueue(device, family, 0, &queue);
  VkPhysicalDeviceProperties properties;
  vkGetPhysicalDeviceProperties(physical, &properties);

  Buffer controls = createBuffer(STATE_BUFFER_BYTES, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
  memcpy(controls.mapped, state, 1024);
  memcpy(controls.mapped + 1024, data, dataSize);
  size_t privateBytes = (memorySize + 4095) / 4096 * 4096;
  const char *bytes = getenv("HB_PRIVATE_BYTES");
  if (bytes && (size_t)atol(bytes) > privateBytes) privateBytes = (size_t)atol(bytes);
  Buffer memory = createBuffer(privateBytes, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
  memcpy(memory.mapped, initial, memorySize);
  Buffer readback = createBuffer((size_t)WIDTH * HEIGHT * 4, VK_BUFFER_USAGE_TRANSFER_DST_BIT);

  VkImageCreateInfo imageInfo = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO,
      .imageType = VK_IMAGE_TYPE_2D,
      .format = VK_FORMAT_R8G8B8A8_UNORM,
      .extent = {WIDTH, HEIGHT, 1},
      .mipLevels = 1,
      .arrayLayers = 1,
      .samples = VK_SAMPLE_COUNT_1_BIT,
      .tiling = VK_IMAGE_TILING_OPTIMAL,
      .usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
      .sharingMode = VK_SHARING_MODE_EXCLUSIVE,
      .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED};
  VkImage image;
  VK(vkCreateImage(device, &imageInfo, 0, &image));
  VkMemoryRequirements imageRequirements;
  vkGetImageMemoryRequirements(device, image, &imageRequirements);
  VkDeviceMemory imageMemory = allocate(imageRequirements, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
  VK(vkBindImageMemory(device, image, imageMemory, 0));
  VkImageViewCreateInfo viewInfo = {.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO,
                                    .image = image,
                                    .viewType = VK_IMAGE_VIEW_TYPE_2D,
                                    .format = VK_FORMAT_R8G8B8A8_UNORM,
                                    .subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1}};
  VkImageView view;
  VK(vkCreateImageView(device, &viewInfo, 0, &view));
  VkAttachmentDescription attachment = {.format = VK_FORMAT_R8G8B8A8_UNORM,
                                        .samples = VK_SAMPLE_COUNT_1_BIT,
                                        .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
                                        .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
                                        .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE,
                                        .stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE,
                                        .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
                                        .finalLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL};
  VkAttachmentReference colorReference = {0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
  VkSubpassDescription subpass = {.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS,
                                  .colorAttachmentCount = 1,
                                  .pColorAttachments = &colorReference};
  VkRenderPassCreateInfo renderPassInfo = {.sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO,
                                           .attachmentCount = 1,
                                           .pAttachments = &attachment,
                                           .subpassCount = 1,
                                           .pSubpasses = &subpass};
  VkRenderPass renderPass;
  VK(vkCreateRenderPass(device, &renderPassInfo, 0, &renderPass));
  VkFramebufferCreateInfo framebufferInfo = {.sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO,
                                             .renderPass = renderPass,
                                             .attachmentCount = 1,
                                             .pAttachments = &view,
                                             .width = WIDTH,
                                             .height = HEIGHT,
                                             .layers = 1};
  VkFramebuffer framebuffer;
  VK(vkCreateFramebuffer(device, &framebufferInfo, 0, &framebuffer));

  VkDescriptorSetLayoutBinding bindings[2];
  for (uint32_t i = 0; i < 2; i++)
    bindings[i] = (VkDescriptorSetLayoutBinding){
        .binding = i,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
        .descriptorCount = 1,
        .stageFlags = VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT |
                      VK_SHADER_STAGE_COMPUTE_BIT};
  VkDescriptorSetLayoutCreateInfo setLayoutInfo = {
      .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
      .bindingCount = 2,
      .pBindings = bindings};
  VkDescriptorSetLayout setLayout;
  VK(vkCreateDescriptorSetLayout(device, &setLayoutInfo, 0, &setLayout));
  VkPipelineLayoutCreateInfo layoutInfo = {.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                           .setLayoutCount = 1,
                                           .pSetLayouts = &setLayout};
  VkPipelineLayout layout;
  VK(vkCreatePipelineLayout(device, &layoutInfo, 0, &layout));
  VkDescriptorPoolSize poolSize = {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 2};
  VkDescriptorPoolCreateInfo poolInfo = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
                                         .maxSets = 1,
                                         .poolSizeCount = 1,
                                         .pPoolSizes = &poolSize};
  VkDescriptorPool pool;
  VK(vkCreateDescriptorPool(device, &poolInfo, 0, &pool));
  VkDescriptorSetAllocateInfo setInfo = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                         .descriptorPool = pool,
                                         .descriptorSetCount = 1,
                                         .pSetLayouts = &setLayout};
  VkDescriptorSet set;
  VK(vkAllocateDescriptorSets(device, &setInfo, &set));
  VkDescriptorBufferInfo bufferInfos[2] = {{controls.buffer, 0, VK_WHOLE_SIZE},
                                           {memory.buffer, 0, VK_WHOLE_SIZE}};
  VkWriteDescriptorSet writes[2];
  for (uint32_t i = 0; i < 2; i++)
    writes[i] = (VkWriteDescriptorSet){.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,
                                       .dstSet = set,
                                       .dstBinding = i,
                                       .descriptorCount = 1,
                                       .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
                                       .pBufferInfo = &bufferInfos[i]};
  vkUpdateDescriptorSets(device, 2, writes, 0, 0);

  VkShaderModule vertex = shader(shaderDir, "vert"), fragment = shader(shaderDir, "frag"),
                 compute = shader(shaderDir, "comp");
  VkComputePipelineCreateInfo computeInfo = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
      .stage = {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
                .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                .module = compute,
                .pName = "main"},
      .layout = layout};
  VkPipeline computePipeline;
  VK(vkCreateComputePipelines(device, 0, 1, &computeInfo, 0, &computePipeline));
  VkPipelineShaderStageCreateInfo stages[2] = {
      {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
       .stage = VK_SHADER_STAGE_VERTEX_BIT,
       .module = vertex,
       .pName = "main"},
      {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
       .stage = VK_SHADER_STAGE_FRAGMENT_BIT,
       .module = fragment,
       .pName = "main"}};
  VkPipelineVertexInputStateCreateInfo vertexInput = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};
  VkPipelineInputAssemblyStateCreateInfo assembly = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
      .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST};
  VkViewport viewport = {0, 0, WIDTH, HEIGHT, 0, 1};
  VkRect2D scissor = {{0, 0}, {WIDTH, HEIGHT}};
  VkPipelineViewportStateCreateInfo viewportState = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO,
      .viewportCount = 1,
      .pViewports = &viewport,
      .scissorCount = 1,
      .pScissors = &scissor};
  VkPipelineRasterizationStateCreateInfo raster = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
      .polygonMode = VK_POLYGON_MODE_FILL,
      .cullMode = VK_CULL_MODE_NONE,
      .lineWidth = 1};
  VkPipelineMultisampleStateCreateInfo multisample = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
      .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT};
  VkPipelineColorBlendAttachmentState blendAttachment = {.colorWriteMask = 15};
  VkPipelineColorBlendStateCreateInfo blend = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
      .attachmentCount = 1,
      .pAttachments = &blendAttachment};
  VkGraphicsPipelineCreateInfo graphicsInfo = {
      .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO,
      .stageCount = 2,
      .pStages = stages,
      .pVertexInputState = &vertexInput,
      .pInputAssemblyState = &assembly,
      .pViewportState = &viewportState,
      .pRasterizationState = &raster,
      .pMultisampleState = &multisample,
      .pColorBlendState = &blend,
      .layout = layout,
      .renderPass = renderPass};
  VkPipeline graphicsPipeline;
  VK(vkCreateGraphicsPipelines(device, 0, 1, &graphicsInfo, 0, &graphicsPipeline));

  VkQueryPoolCreateInfo queryInfo = {.sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO,
                                     .queryType = VK_QUERY_TYPE_TIMESTAMP,
                                     .queryCount = 3};
  VkQueryPool queries;
  VK(vkCreateQueryPool(device, &queryInfo, 0, &queries));
  VkCommandPoolCreateInfo commandPoolInfo = {.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
                                             .queueFamilyIndex = family};
  VkCommandPool commandPool;
  VK(vkCreateCommandPool(device, &commandPoolInfo, 0, &commandPool));
  VkCommandBufferAllocateInfo commandInfo = {
      .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
      .commandPool = commandPool,
      .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
      .commandBufferCount = 1};
  VkCommandBuffer cmd;
  VK(vkAllocateCommandBuffers(device, &commandInfo, &cmd));
  VkCommandBufferBeginInfo beginInfo = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
  VK(vkBeginCommandBuffer(cmd, &beginInfo));
  vkCmdResetQueryPool(cmd, queries, 0, 3);
  memoryBarrier(cmd, VK_PIPELINE_STAGE_HOST_BIT | VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT,
                VK_ACCESS_HOST_WRITE_BIT | VK_ACCESS_SHADER_WRITE_BIT,
                VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT);
  vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, queries, 0);
  vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, 0);
  vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, computePipeline);
  vkCmdDispatch(cmd, 1, 1, 1);
  vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, queries, 1);
  memoryBarrier(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_ACCESS_SHADER_WRITE_BIT,
                VK_PIPELINE_STAGE_VERTEX_SHADER_BIT | VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT,
                VK_ACCESS_SHADER_READ_BIT);
  VkClearValue clear = {.color = {{0, 0, 0, 1}}};
  VkRenderPassBeginInfo renderInfo = {.sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO,
                                      .renderPass = renderPass,
                                      .framebuffer = framebuffer,
                                      .renderArea = {{0, 0}, {WIDTH, HEIGHT}},
                                      .clearValueCount = 1,
                                      .pClearValues = &clear};
  vkCmdBeginRenderPass(cmd, &renderInfo, VK_SUBPASS_CONTENTS_INLINE);
  vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &set, 0, 0);
  vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, graphicsPipeline);
  vkCmdDraw(cmd, 3, 1, 0, 0);
  vkCmdEndRenderPass(cmd);
  vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, queries, 2);
  VkBufferImageCopy copy = {.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1},
                            .imageExtent = {WIDTH, HEIGHT, 1}};
  vkCmdCopyImageToBuffer(cmd, image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, readback.buffer, 1,
                         &copy);
  memoryBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT | VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT |
                         VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT,
                VK_ACCESS_TRANSFER_WRITE_BIT | VK_ACCESS_SHADER_WRITE_BIT,
                VK_PIPELINE_STAGE_HOST_BIT, VK_ACCESS_HOST_READ_BIT);
  VK(vkEndCommandBuffer(cmd));

  VkSubmitInfo submit = {.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
                         .commandBufferCount = 1,
                         .pCommandBuffers = &cmd};
  printf("{\"frames\":[");
  for (int frame = 0; frame < argc - 5; frame++) {
    if (frame > 0) {
      size_t size;
      uint8_t *patch = readFile(argv[5 + frame], &size);
      CHECK(size >= 4);
      uint32_t offset;
      memcpy(&offset, patch, 4);
      CHECK(offset + size - 4 <= memory.size);
      memcpy(memory.mapped + offset, patch + 4, size - 4);
      free(patch);
    }
    VK(vkQueueSubmit(queue, 1, &submit, 0));
    VK(vkQueueWaitIdle(queue));
    uint64_t stamps[3];
    VK(vkGetQueryPoolResults(device, queries, 0, 3, sizeof stamps, stamps, 8,
                             VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT));
    double tick = properties.limits.timestampPeriod / 1e6;
    printf("%s{\"computeMs\":%.3f,\"drawMs\":%.3f}", frame ? "," : "",
           (stamps[1] - stamps[0]) * tick, (stamps[2] - stamps[1]) * tick);
  }
  printf("],\"device\":\"%s\"}\n", properties.deviceName);
  writeFile(outDir, "state.bin", controls.mapped, 1024);
  writeFile(outDir, "memory.bin", memory.mapped, memory.size);
  writeFile(outDir, "frame.rgba", readback.mapped, readback.size);
  vkDeviceWaitIdle(device);
  return 0;
}
