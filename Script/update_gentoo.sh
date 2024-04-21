#!/bin/bash

emaint --auto sync
emerge --ask --verbose --update --deep --newuse @world
