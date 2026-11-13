QJS = ../quickjs-ng
CFLAGS = -O2 -g -Wall -Wno-unused-parameter -I$(QJS) -Isrc -std=gnu11
LDFLAGS =
LIBS = $(QJS)/build/libqjs.a -lssl -lcrypto -lm -ldl -lpthread

SRC = src/main.c src/native.c
BIN = build/mosnode

all: $(BIN)

$(BIN): $(SRC) src/mosnode.h
	@mkdir -p build
	$(CC) $(CFLAGS) -o $@ $(SRC) $(LIBS)

clean:
	rm -rf build

.PHONY: all clean
