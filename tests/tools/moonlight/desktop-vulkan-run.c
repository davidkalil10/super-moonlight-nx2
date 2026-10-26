// Offscreen runner for desktop.vulkan HB packages, adapted from gpu-check.c.
// Binding 0 is one persistent 8 MiB control+data buffer: the 1024-byte state,
// then the data image. Per frame it applies the host writes from the frame
// file, then compute, barrier, draw at 1920x1080, submit/wait and RGBA readback.
//   desktop-vulkan-run --probe
//   desktop-vulkan-run VERT FRAG COMP STATE DATA FRAMES OUTDIR
// FRAMES holds per frame a u32 write count then u32 offset/value pairs into
// the control block. OUTDIR receives frame.rgba (last frame), state.bin,
// states.bin (state after every frame) and data.bin. The JSON report goes to
// stdout only after every frame and file succeeded. Exit 2: no usable device.
// Tests set DESKTOP_VULKAN_RUN_FAIL=control|readback|image to fail that allocation.
#include <vulkan/vulkan.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(x)                                                              \
  do {                                                                        \
    if (!(x)) {                                                               \
      fprintf(stderr, "desktop-vulkan-run: failed at %d: %s\n", __LINE__, #x); \
      exit(1);                                                                \
    }                                                                         \
  } while (0)
#define VK(x) CHECK((x) == VK_SUCCESS)

enum {
  WIDTH = 1920,
  HEIGHT = 1080,
  STATE_BYTES = 1024,
  BUFFER_BYTES = 8 << 20,
  MAX_DATA_BYTES = 7 << 20,
  MAX_FRAMES = 3600,
  MAX_WRITES = 64,
  MAX_FRAMES_BYTES = MAX_FRAMES * (4 + 8 * MAX_WRITES),
  MAX_SPIRV_BYTES = 16 << 20,
  SPIRV_MAGIC = 0x07230203,
  NO_DEVICE = 2
};

typedef struct {
  VkBuffer buffer;
  VkDeviceMemory memory;
  uint8_t *mapped;
  size_t size;
} Buffer;

typedef struct {
  double computeMs, drawMs;
} Timing;

static VkPhysicalDevice physical;
static VkDevice device;

static void *readFile(const char *name, size_t *size, size_t max) {
  FILE *f = fopen(name, "rb");
  if (!f) fprintf(stderr, "desktop-vulkan-run: cannot read %s\n", name);
  CHECK(f);
  CHECK(!fseek(f, 0, SEEK_END));
  long end = ftell(f);
  CHECK(end >= 0 && (unsigned long)end <= max);
  *size = (size_t)end;
  rewind(f);
  void *bytes = malloc(*size ? *size : 1);
  CHECK(bytes && fread(bytes, 1, *size, f) == *size);
  fclose(f);
  return bytes;
}

static void writeFile(const char *dir, const char *name, const void *bytes, size_t size) {
  char path[4096];
  CHECK(snprintf(path, sizeof path, "%s/%s", dir, name) < (int)sizeof path);
  FILE *f = fopen(path, "wb");
  if (!f) fprintf(stderr, "desktop-vulkan-run: cannot write %s\n", path);
  CHECK(f && fwrite(bytes, 1, size, f) == size);
  CHECK(!fclose(f));
}

static uint32_t word(const uint8_t *bytes) {
  uint32_t value;
  memcpy(&value, bytes, 4);
  return value;
}

// Counts frames and checks every write lands inside the control block.
static uint32_t checkFrames(const uint8_t *frames, size_t size) {
  CHECK(size % 4 == 0);
  uint32_t count = 0;
  for (size_t at = 0; at < size; count++) {
    uint32_t writes = word(frames + at);
    at += 4;
    CHECK(writes <= MAX_WRITES && at + (size_t)writes * 8 <= size);
    for (uint32_t i = 0; i < writes; i++, at += 8) {
      uint32_t offset = word(frames + at);
      CHECK(offset % 4 == 0 && offset <= STATE_BYTES - 4);
    }
  }
  CHECK(count > 0 && count <= MAX_FRAMES);
  return count;
}

static size_t applyFrame(uint8_t *state, const uint8_t *frames, size_t at) {
  uint32_t writes = word(frames + at);
  at += 4;
  for (uint32_t i = 0; i < writes; i++, at += 8)
    memcpy(state + word(frames + at), frames + at + 4, 4);
  return at;
}

static uint32_t memoryType(uint32_t bits, uint32_t flags) {
  VkPhysicalDeviceMemoryProperties properties;
  vkGetPhysicalDeviceMemoryProperties(physical, &properties);
  for (uint32_t i = 0; i < properties.memoryTypeCount; i++)
    if ((bits & (1u << i)) && (properties.memoryTypes[i].propertyFlags & flags) == flags) return i;
  CHECK(0);
  return 0;
}

static VkDeviceMemory allocate(const char *name, VkMemoryRequirements requirements,
                               uint32_t flags) {
  VkMemoryAllocateInfo info = {.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
                               .allocationSize = requirements.size,
                               .memoryTypeIndex = memoryType(requirements.memoryTypeBits, flags)};
  VkDeviceMemory memory;
  const char *fail = getenv("DESKTOP_VULKAN_RUN_FAIL");
  VkResult result = fail && !strcmp(fail, name) ? VK_ERROR_OUT_OF_DEVICE_MEMORY
                                                : vkAllocateMemory(device, &info, 0, &memory);
  if (result != VK_SUCCESS) fprintf(stderr, "desktop-vulkan-run: cannot allocate %s\n", name);
  VK(result);
  return memory;
}

static Buffer createBuffer(const char *name, size_t size, VkBufferUsageFlags usage) {
  Buffer b = {.size = size};
  VkBufferCreateInfo info = {.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
                             .size = size,
                             .usage = usage,
                             .sharingMode = VK_SHARING_MODE_EXCLUSIVE};
  VK(vkCreateBuffer(device, &info, 0, &b.buffer));
  VkMemoryRequirements requirements;
  vkGetBufferMemoryRequirements(device, b.buffer, &requirements);
  b.memory = allocate(name, requirements,
                      VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
  VK(vkBindBufferMemory(device, b.buffer, b.memory, 0));
  VK(vkMapMemory(device, b.memory, 0, size, 0, (void **)&b.mapped));
  CHECK(b.mapped);
  memset(b.mapped, 0, size);
  return b;
}

static VkShaderModule shader(const char *path) {
  size_t size;
  uint32_t *code = readFile(path, &size, MAX_SPIRV_BYTES);
  if (size < 20 || size % 4 || code[0] != SPIRV_MAGIC)
    fprintf(stderr, "desktop-vulkan-run: not SPIR-V: %s\n", path);
  CHECK(size >= 20 && size % 4 == 0 && code[0] == SPIRV_MAGIC);
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

// Prefers a discrete GPU, then an integrated one, then anything with a
// graphics+compute queue and timestamps; exits NO_DEVICE when there is none.
static uint32_t pickDevice(VkInstance instance) {
  VkPhysicalDevice devices[16];
  uint32_t count = 16;
  VkResult enumerated = vkEnumeratePhysicalDevices(instance, &count, devices);
  if (enumerated != VK_SUCCESS && enumerated != VK_INCOMPLETE) count = 0;
  const VkPhysicalDeviceType rank[] = {VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU,
                                       VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU,
                                       VK_PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU,
                                       VK_PHYSICAL_DEVICE_TYPE_CPU,
                                       VK_PHYSICAL_DEVICE_TYPE_OTHER};
  const VkQueueFlags wanted = VK_QUEUE_GRAPHICS_BIT | VK_QUEUE_COMPUTE_BIT;
  for (size_t r = 0; r < sizeof rank / sizeof rank[0]; r++)
    for (uint32_t d = 0; d < count; d++) {
      VkPhysicalDeviceProperties properties;
      vkGetPhysicalDeviceProperties(devices[d], &properties);
      if (properties.deviceType != rank[r]) continue;
      VkQueueFamilyProperties families[64];
      uint32_t familyCount = 64;
      vkGetPhysicalDeviceQueueFamilyProperties(devices[d], &familyCount, families);
      for (uint32_t f = 0; f < familyCount; f++)
        if ((families[f].queueFlags & wanted) == wanted && families[f].timestampValidBits) {
          physical = devices[d];
          return f;
        }
    }
  fprintf(stderr, "desktop-vulkan-run: no Vulkan device with graphics, compute and timestamps\n");
  exit(NO_DEVICE);
}

static void printDevice(const VkPhysicalDeviceProperties *p) {
  printf("\"device\":{\"name\":\"%s\",\"vendorId\":%u,\"deviceId\":%u,\"driverVersion\":%u,"
         "\"apiVersion\":%u}",
         p->deviceName, p->vendorID, p->deviceID, p->driverVersion, p->apiVersion);
}

int main(int argc, char **argv) {
  int probe = argc == 2 && !strcmp(argv[1], "--probe");
  if (!probe && argc != 8) {
    fprintf(stderr, "usage: desktop-vulkan-run --probe | VERT FRAG COMP STATE DATA FRAMES OUTDIR\n");
    return 1;
  }
  size_t stateSize = 0, dataSize = 0, framesSize = 0;
  uint8_t *state = 0, *data = 0, *frames = 0;
  uint32_t frameCount = 0;
  const char *outDir = probe ? 0 : argv[7];
  if (!probe) {
    state = readFile(argv[4], &stateSize, STATE_BYTES);
    data = readFile(argv[5], &dataSize, MAX_DATA_BYTES);
    frames = readFile(argv[6], &framesSize, MAX_FRAMES_BYTES);
    CHECK(stateSize == STATE_BYTES);
    CHECK(dataSize > 0 && dataSize % 4 == 0 && dataSize <= MAX_DATA_BYTES);
    frameCount = checkFrames(frames, framesSize);
  }

  VkApplicationInfo app = {.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
                           .pApplicationName = "HB desktop.vulkan",
                           .apiVersion = VK_API_VERSION_1_0};
  VkInstanceCreateInfo instanceInfo = {.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
                                       .pApplicationInfo = &app};
  VkInstance instance;
  if (vkCreateInstance(&instanceInfo, 0, &instance) != VK_SUCCESS) {
    fprintf(stderr, "desktop-vulkan-run: no Vulkan instance\n");
    return NO_DEVICE;
  }
  uint32_t family = pickDevice(instance);
  VkPhysicalDeviceProperties properties;
  vkGetPhysicalDeviceProperties(physical, &properties);
  if (probe) {
    printf("{");
    printDevice(&properties);
    printf("}\n");
    return 0;
  }
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

  Buffer controls = createBuffer("control", BUFFER_BYTES, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
  memcpy(controls.mapped, state, STATE_BYTES);
  memcpy(controls.mapped + STATE_BYTES, data, dataSize);
  Buffer readback =
      createBuffer("readback", (size_t)WIDTH * HEIGHT * 4, VK_BUFFER_USAGE_TRANSFER_DST_BIT);
  uint8_t *states = malloc((size_t)frameCount * STATE_BYTES);
  Timing *timings = malloc(frameCount * sizeof *timings);
  CHECK(states && timings);

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
  VkDeviceMemory imageMemory =
      allocate("image", imageRequirements, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
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
  // Orders the color writes and the move to TRANSFER_SRC before the readback copy.
  VkSubpassDependency toCopy = {.srcSubpass = 0,
                                .dstSubpass = VK_SUBPASS_EXTERNAL,
                                .srcStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,
                                .dstStageMask = VK_PIPELINE_STAGE_TRANSFER_BIT,
                                .srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT,
                                .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT};
  VkRenderPassCreateInfo renderPassInfo = {.sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO,
                                           .attachmentCount = 1,
                                           .pAttachments = &attachment,
                                           .subpassCount = 1,
                                           .pSubpasses = &subpass,
                                           .dependencyCount = 1,
                                           .pDependencies = &toCopy};
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

  VkDescriptorSetLayoutBinding binding = {
      .binding = 0,
      .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
      .descriptorCount = 1,
      .stageFlags =
          VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT | VK_SHADER_STAGE_COMPUTE_BIT};
  VkDescriptorSetLayoutCreateInfo setLayoutInfo = {
      .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
      .bindingCount = 1,
      .pBindings = &binding};
  VkDescriptorSetLayout setLayout;
  VK(vkCreateDescriptorSetLayout(device, &setLayoutInfo, 0, &setLayout));
  VkPipelineLayoutCreateInfo layoutInfo = {.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                           .setLayoutCount = 1,
                                           .pSetLayouts = &setLayout};
  VkPipelineLayout layout;
  VK(vkCreatePipelineLayout(device, &layoutInfo, 0, &layout));
  VkDescriptorPoolSize poolSize = {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1};
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
  VkDescriptorBufferInfo bufferInfo = {controls.buffer, 0, VK_WHOLE_SIZE};
  VkWriteDescriptorSet write = {.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,
                                .dstSet = set,
                                .dstBinding = 0,
                                .descriptorCount = 1,
                                .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
                                .pBufferInfo = &bufferInfo};
  vkUpdateDescriptorSets(device, 1, &write, 0, 0);

  VkShaderModule vertex = shader(argv[1]), fragment = shader(argv[2]), compute = shader(argv[3]);
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
  memoryBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT | VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                VK_ACCESS_TRANSFER_WRITE_BIT | VK_ACCESS_SHADER_WRITE_BIT,
                VK_PIPELINE_STAGE_HOST_BIT, VK_ACCESS_HOST_READ_BIT);
  VK(vkEndCommandBuffer(cmd));

  VkSubmitInfo submit = {.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
                         .commandBufferCount = 1,
                         .pCommandBuffers = &cmd};
  double tick = properties.limits.timestampPeriod / 1e6;
  size_t at = 0;
  for (uint32_t frame = 0; frame < frameCount; frame++) {
    at = applyFrame(controls.mapped, frames, at);
    VK(vkQueueSubmit(queue, 1, &submit, 0));
    VK(vkQueueWaitIdle(queue));
    uint64_t stamps[3];
    VK(vkGetQueryPoolResults(device, queries, 0, 3, sizeof stamps, stamps, 8,
                             VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT));
    timings[frame] = (Timing){(stamps[1] - stamps[0]) * tick, (stamps[2] - stamps[1]) * tick};
    memcpy(states + (size_t)frame * STATE_BYTES, controls.mapped, STATE_BYTES);
  }
  vkDeviceWaitIdle(device);
  writeFile(outDir, "frame.rgba", readback.mapped, readback.size);
  writeFile(outDir, "state.bin", controls.mapped, STATE_BYTES);
  writeFile(outDir, "states.bin", states, (size_t)frameCount * STATE_BYTES);
  writeFile(outDir, "data.bin", controls.mapped + STATE_BYTES, dataSize);

  printf("{");
  printDevice(&properties);
  printf(",\"width\":%d,\"height\":%d,\"frames\":[", WIDTH, HEIGHT);
  for (uint32_t frame = 0; frame < frameCount; frame++)
    printf("%s{\"computeMs\":%.3f,\"drawMs\":%.3f}", frame ? "," : "", timings[frame].computeMs,
           timings[frame].drawMs);
  printf("]}\n");
  return 0;
}
