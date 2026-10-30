// The app's clipboard glue for Slack token pickup. Electron has no public way to read the
// clipboard's change count, which pickup needs so it takes only a copy made after the owner armed
// it, reads each copy once and clears exactly that copy. This helper answers three commands on
// its private stdin pipe, one per line, never through arguments, files or logs:
//   r        -> the change count
//   t <rev>  -> the plain text, only while the change count is still <rev>: "<bytes>\n<text>",
//               "-" when it changed, "0" with no text, "L" when longer than 4,096 bytes
//   c <rev>  -> clears the clipboard only while the change count is still <rev>: "1" or "0"
// It exits when stdin closes.
#import <AppKit/AppKit.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const NSUInteger textLimit = 4096;

static void answer(const char *line) {
  fputs(line, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

int main(void) {
  @autoreleasepool {
    char line[64];
    while (fgets(line, sizeof line, stdin)) {
      @autoreleasepool {
        NSPasteboard *board = [NSPasteboard generalPasteboard];
        NSInteger revision = [board changeCount];
        char command = line[0];
        long asked = (command == 't' || command == 'c') && line[1] == ' ' ? strtol(line + 2, NULL, 10) : -1;
        if (command == 'r') {
          char text[32];
          snprintf(text, sizeof text, "%ld", (long)revision);
          answer(text);
        } else if (command == 't') {
          if (asked != revision) {
            answer("-");
            continue;
          }
          NSString *value = [board stringForType:NSPasteboardTypeString];
          if ([board changeCount] != revision) {
            answer("-");
            continue;
          }
          if (!value) {
            answer("0");
            continue;
          }
          NSData *bytes = [value dataUsingEncoding:NSUTF8StringEncoding];
          if (!bytes || [bytes length] == 0) {
            answer("0");
            continue;
          }
          if ([bytes length] > textLimit) {
            answer("L");
            continue;
          }
          char size[32];
          snprintf(size, sizeof size, "%lu", (unsigned long)[bytes length]);
          fputs(size, stdout);
          fputc('\n', stdout);
          fwrite([bytes bytes], 1, [bytes length], stdout);
          fflush(stdout);
        } else if (command == 'c') {
          if (asked == revision) {
            [board clearContents];
            answer("1");
          } else {
            answer("0");
          }
        } else {
          answer("?");
        }
      }
    }
  }
  return 0;
}
