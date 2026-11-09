#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

void *moonlightRustAllocate(size_t bytes, size_t alignment)
{
    if (alignment < sizeof(void *))
        alignment = sizeof(void *);

    if (bytes > SIZE_MAX - (alignment - 1))
        return NULL;
    size_t padded = (bytes + alignment - 1) & ~(alignment - 1);
    return aligned_alloc(alignment, padded);
}

void moonlightRustDeallocate(void *memory)
{
    free(memory);
}

_Noreturn void moonlightRustAbort(void)
{
    abort();
}
