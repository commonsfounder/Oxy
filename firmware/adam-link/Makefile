SRC = adam_link.c ../sound-events/sound_events.c ../alarm-pattern/alarm_pattern.c
INC = -I. -I../sound-events -I../alarm-pattern

test: $(SRC) test_adam_link.c adam_link.h
	$(CC) -O2 -Wall -Wextra -Werror $(INC) $(SRC) test_adam_link.c -lm -o test_adam_link && ./test_adam_link
clean:
	rm -f test_adam_link
