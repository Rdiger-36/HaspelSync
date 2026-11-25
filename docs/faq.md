# FAQ

[← Documentation](README.md)

**I cannot merge my existing spool, only create a new one, or the container creates it automatically.**

Check the *filament* in Spoolman, not the spool. The material has to match the one shown in the Web UI or the logs exactly: `PETG HF` is not the same as `PETG`.

**Do I have to put my printer into LAN only mode?**

No. Cloud mode, LAN only mode and developer mode all work. Everything this service reads comes from the printer itself over the LAN, MQTT on 8883 and FTPS on 990, and those are served in every one of the three. Nothing is sent to the Bambu cloud. The one thing read from it is the sliced file of a cloud print that never reached the printer's storage, which Bambu Studio 2.9.2 and newer cause: the printer names the download link of the job itself, the service fetches the file from there, and the link holds no account data and needs no login.
