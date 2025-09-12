#!/bin/bash

eix-sync
emerge --ask --verbose --update --deep --newuse @world
