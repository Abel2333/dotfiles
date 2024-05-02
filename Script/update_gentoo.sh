#!/bin/bash

emaint --auto sync
eix-sync
emerge --ask --verbose --update --deep --newuse @world
