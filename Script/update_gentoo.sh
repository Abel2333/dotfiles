#!/bin/bash

eix-sync
emerge --regen
emerge --ask --verbose --update --deep --newuse @world
