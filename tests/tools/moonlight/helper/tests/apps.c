#include "helper.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <xml.h>

void status(const char *format, ...) {}
void json_string(char *out, size_t size, const char *text) {}

static PAPP_LIST parse(const char *xml) {
  PAPP_LIST apps = NULL;
  char *data = strdup(xml);
  assert(xml_applist(data, strlen(data), &apps) == 0);
  free(data);
  return session_host_order(apps);
}

int main(void) {
  PAPP_LIST apps = parse("<root status_code=\"200\">"
                         "<App><AppTitle>A</AppTitle><ID>11</ID></App>"
                         "<App><AppTitle>B</AppTitle><ID>22</ID></App>"
                         "<App><AppTitle>C</AppTitle><ID>33</ID></App>"
                         "</root>");
  assert(apps && strcmp(apps->name, "A") == 0 && apps->id == 11);
  assert(apps->next && strcmp(apps->next->name, "B") == 0 && apps->next->id == 22);
  assert(apps->next->next && strcmp(apps->next->next->name, "C") == 0);
  assert(apps->next->next->next == NULL);

  apps = parse("<root status_code=\"200\"><App><AppTitle>A</AppTitle><ID>1</ID></App></root>");
  assert(apps && strcmp(apps->name, "A") == 0 && apps->next == NULL);
  assert(parse("<root status_code=\"200\"></root>") == NULL);
  puts("App list keeps the host order");
  return 0;
}
