CFLAGS ?= -O2 -Wall -Wextra
test_alarm: alarm_pattern.c test_alarm.c alarm_pattern.h
	$(CC) $(CFLAGS) alarm_pattern.c test_alarm.c -o $@ -lm

test: test_alarm
	./test_alarm $(SMOKE) $(ESC50)

clean:
	rm -f test_alarm
