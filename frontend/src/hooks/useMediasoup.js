import { useCallback, useEffect, useRef, useState } from "react";
import * as mediasoupClient from "mediasoup-client";
import { emitAck } from "../services/socket";

export function useMediasoup({ socket, role, enabled }) {
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);
  const producersRef = useRef({});
  const consumersRef = useRef(new Map());

  const [localStream, setLocalStream] = useState(null);
  const [teacherStream, setTeacherStream] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(role === "teacher");
  const [sharing, setSharing] = useState(false);
  const [ready, setReady] = useState(false);

  const teacherStreamRef = useRef(new MediaStream());
  const screenStreamRef = useRef(new MediaStream());

  const attachRemoteTrack = useCallback((track, source) => {
    try {
      console.log("[Mediasoup] attachRemoteTrack", source, track.kind);
      if (source === "screen") {
        screenStreamRef.current.addTrack(track);
        setScreenStream(new MediaStream(screenStreamRef.current.getTracks()));
      } else {
        teacherStreamRef.current.addTrack(track);
        setTeacherStream(new MediaStream(teacherStreamRef.current.getTracks()));
      }
    } catch (err) {
      console.error("[Mediasoup] attachRemoteTrack failed", err);
    }
  }, []);

  const consumeProducer = useCallback(
    async (producer) => {
      try {
        if (!deviceRef.current || !recvTransportRef.current) return;
        if (producer.role !== "teacher" && producer.source !== "audio") {
          console.log("[Mediasoup] skip non-teacher video/screen", producer);
          return;
        }
        console.log("[Mediasoup] consumeProducer", producer);
        const res = await emitAck("consume", {
          producerId: producer.producerId,
          transportId: recvTransportRef.current.id,
          rtpCapabilities: deviceRef.current.rtpCapabilities,
        });
        const { params } = res;
        const consumer = await recvTransportRef.current.consume({
          id: params.id,
          producerId: params.producerId,
          kind: params.kind,
          rtpParameters: params.rtpParameters,
        });
        consumersRef.current.set(consumer.id, consumer);
        attachRemoteTrack(consumer.track, producer.source);
        await emitAck("resume-consumer", { consumerId: consumer.id });
      } catch (err) {
        console.error("[Mediasoup] consumeProducer failed", err);
      }
    },
    [attachRemoteTrack],
  );

  const startLocalMedia = useCallback(async () => {
    try {
      const constraints =
        role === "teacher"
          ? { audio: true, video: { width: 1280, height: 720 } }
          : { audio: true, video: false };
      console.log("[Mediasoup] getUserMedia", constraints);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      setLocalStream(stream);
      if (role === "teacher") setTeacherStream(stream);

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && sendTransportRef.current) {
        const producer = await sendTransportRef.current.produce({
          track: audioTrack,
          appData: { source: "audio" },
        });
        producersRef.current.audio = producer;
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && role === "teacher" && sendTransportRef.current) {
        const producer = await sendTransportRef.current.produce({
          track: videoTrack,
          appData: { source: "video" },
        });
        producersRef.current.video = producer;
        setCamOn(true);
      }
    } catch (err) {
      console.error("[Mediasoup] startLocalMedia failed", err);
      throw err;
    }
  }, [role]);

  const initDevice = useCallback(
    async ({ routerRtpCapabilities, iceServers }) => {
      try {
        console.log("[Mediasoup] initDevice");
        const device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities });
        deviceRef.current = device;

        const makeTransport = async (direction) => {
          const { params } = await emitAck("create-transport", { direction });
          const transport =
            direction === "send"
              ? device.createSendTransport({ ...params, iceServers })
              : device.createRecvTransport({ ...params, iceServers });

          transport.on("connect", async ({ dtlsParameters }, callback, errback) => {
            try {
              console.log("[Mediasoup] transport connect", direction);
              await emitAck("connect-transport", {
                transportId: transport.id,
                dtlsParameters,
              });
              callback();
            } catch (err) {
              console.error("[Mediasoup] transport connect failed", err);
              errback(err);
            }
          });

          if (direction === "send") {
            transport.on("produce", async ({ kind, rtpParameters, appData }, callback, errback) => {
              try {
                console.log("[Mediasoup] produce", kind, appData);
                const res = await emitAck("produce", {
                  transportId: transport.id,
                  kind,
                  rtpParameters,
                  source: appData?.source || kind,
                });
                callback({ id: res.id });
              } catch (err) {
                console.error("[Mediasoup] produce event failed", err);
                errback(err);
              }
            });
          }

          transport.on("connectionstatechange", (state) => {
            console.log("[Mediasoup] transport state", direction, state);
          });

          return transport;
        };

        sendTransportRef.current = await makeTransport("send");
        recvTransportRef.current = await makeTransport("recv");
        setReady(true);
        await startLocalMedia();
      } catch (err) {
        console.error("[Mediasoup] initDevice failed", err);
        throw err;
      }
    },
    [startLocalMedia],
  );

  useEffect(() => {
    if (!socket || !enabled) return undefined;

    const onNew = (producer) => {
      console.log("[Mediasoup] new-producer", producer);
      consumeProducer(producer);
    };
    const onClosed = ({ producerId, source }) => {
      console.log("[Mediasoup] producer-closed", producerId, source);
      if (source === "screen") {
        screenStreamRef.current = new MediaStream();
        setScreenStream(null);
        setSharing(false);
      }
    };

    socket.on("new-producer", onNew);
    socket.on("producer-closed", onClosed);
    socket.on("force-mute", async () => {
      try {
        console.log("[Mediasoup] force-mute received");
        await emitAck("pause-producer", { source: "audio" });
        localStream?.getAudioTracks().forEach((t) => {
          t.enabled = false;
        });
        setMicOn(false);
      } catch (err) {
        console.error("[Mediasoup] force-mute failed", err);
      }
    });

    return () => {
      socket.off("new-producer", onNew);
      socket.off("producer-closed", onClosed);
      socket.off("force-mute");
    };
  }, [socket, enabled, consumeProducer, localStream]);

  const consumeExisting = useCallback(
    async (producers = []) => {
      try {
        console.log("[Mediasoup] consumeExisting", producers);
        for (const p of producers) {
          await consumeProducer(p);
        }
      } catch (err) {
        console.error("[Mediasoup] consumeExisting failed", err);
      }
    },
    [consumeProducer],
  );

  const toggleMic = useCallback(async () => {
    try {
      const next = !micOn;
      console.log("[Mediasoup] toggleMic", next);
      localStream?.getAudioTracks().forEach((t) => {
        t.enabled = next;
      });
      await emitAck(next ? "resume-producer" : "pause-producer", { source: "audio" });
      setMicOn(next);
    } catch (err) {
      console.error("[Mediasoup] toggleMic failed", err);
    }
  }, [micOn, localStream]);

  const toggleCam = useCallback(async () => {
    try {
      if (role !== "teacher") {
        console.warn("[Mediasoup] students cannot toggle camera");
        return;
      }
      const next = !camOn;
      console.log("[Mediasoup] toggleCam", next);
      localStream?.getVideoTracks().forEach((t) => {
        t.enabled = next;
      });
      await emitAck(next ? "resume-producer" : "pause-producer", { source: "video" });
      setCamOn(next);
    } catch (err) {
      console.error("[Mediasoup] toggleCam failed", err);
    }
  }, [camOn, localStream, role]);

  const startScreen = useCallback(async () => {
    try {
      if (role !== "teacher") throw new Error("Only teacher can share screen");
      console.log("[Mediasoup] startScreen");
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      const producer = await sendTransportRef.current.produce({
        track,
        appData: { source: "screen" },
      });
      producersRef.current.screen = producer;
      setScreenStream(stream);
      setSharing(true);
      track.onended = async () => {
        try {
          await emitAck("close-producer", { source: "screen" });
          producer.close();
          setSharing(false);
          setScreenStream(null);
        } catch (err) {
          console.error("[Mediasoup] screen ended cleanup failed", err);
        }
      };
    } catch (err) {
      console.error("[Mediasoup] startScreen failed", err);
      throw err;
    }
  }, [role]);

  const stopScreen = useCallback(async () => {
    try {
      console.log("[Mediasoup] stopScreen");
      await emitAck("close-producer", { source: "screen" });
      producersRef.current.screen?.close();
      screenStream?.getTracks().forEach((t) => t.stop());
      setSharing(false);
      setScreenStream(null);
    } catch (err) {
      console.error("[Mediasoup] stopScreen failed", err);
    }
  }, [screenStream]);

  const cleanup = useCallback(() => {
    try {
      console.log("[Mediasoup] cleanup");
      localStream?.getTracks().forEach((t) => t.stop());
      screenStream?.getTracks().forEach((t) => t.stop());
      Object.values(producersRef.current).forEach((p) => {
        try {
          p.close();
        } catch (err) {
          console.error("[Mediasoup] close producer", err);
        }
      });
      sendTransportRef.current?.close();
      recvTransportRef.current?.close();
    } catch (err) {
      console.error("[Mediasoup] cleanup failed", err);
    }
  }, [localStream, screenStream]);

  return {
    initDevice,
    consumeExisting,
    toggleMic,
    toggleCam,
    startScreen,
    stopScreen,
    cleanup,
    localStream,
    teacherStream,
    screenStream,
    micOn,
    camOn,
    sharing,
    ready,
  };
}
