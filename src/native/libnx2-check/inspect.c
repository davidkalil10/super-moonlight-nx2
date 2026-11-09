#include <string.h>

#include "runtime/module.h"

#include "inspect.h"

void checkInspectImage(const void *image, size_t size, uintptr_t load_address,
    const char *const *names, size_t count, uintptr_t *addresses, uint32_t *results,
    CheckImageSummary *summary)
{
    ModuleImage view;
    memset(summary, 0, sizeof(*summary));
    summary->read_result = moduleReadImage(&view, image, size, load_address);
    for (size_t i = 0; i < count; i++) {
        addresses[i] = 0;
        results[i] = summary->read_result;
    }
    if (summary->read_result != 0)
        return;

    summary->dynamic_offset = view.dynamic_offset;
    summary->bss_offset = view.bss_offset;
    summary->bss_size = view.bss_size;
    summary->symbol_count = view.symbol_count;
    summary->init_address = view.init_address;
    for (size_t i = 0; i < count; i++)
        results[i] = moduleLookupSymbol(&view, names[i], &addresses[i]);
}
