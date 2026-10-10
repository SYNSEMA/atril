@echo off
set "ATRIL_HOME=%~dp0.."
synsema run "%~dp0atr.syn" -- %*
